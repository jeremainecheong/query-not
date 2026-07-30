/**
 * Workload ingestion — REQUIREMENTS.md F1, Phase 3.
 *
 * The paste box is the demo; this is the product. A query taking 4ms is
 * invisible to anyone reading a slow-query log, and if it runs two million
 * times a day it is costing more than the 8-second report everyone complains
 * about. Nobody pastes *that* query into a tool, because nobody knows it is a
 * problem.
 *
 * Three things make reading pg_stat_statements harder than it looks, and all
 * three are handled here rather than assumed away:
 *
 *   1. **The counters are cumulative.** "Total time 4 hours" means since the
 *      last reset, not since you started looking. Ranking on raw counters
 *      ranks by how long a query has existed. Everything below deltas.
 *
 *   2. **The counters reset.** pg_stat_statements_reset() and server restarts
 *      zero them. A naive delta then goes negative, which reads as a query
 *      that un-ran. A decrease means reset, and the current value *is* the
 *      delta.
 *
 *   3. **Entries get evicted.** Past pg_stat_statements.max (default 5000) the
 *      least-executed entries are dropped. A query vanishing from the view has
 *      not stopped running, and treating absence as zero would silently
 *      under-report it.
 */

import type { PoolClient } from 'pg';

import type { Database } from './db.ts';

export interface WorkloadEntry {
  queryId: string;
  /** Normalised text, with literals already replaced by $1 by Postgres itself. */
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  /** Null on servers too old to report it. High variance means plan instability. */
  stddevMs: number | null;
  rows: number;
  sharedHit: number;
  sharedRead: number;
}

export interface WorkloadWindow {
  /** True when this is a delta between two snapshots rather than raw counters. */
  isDelta: boolean;
  fromAt: string | null;
  toAt: string;
  /** Set when the counters were reset between the two snapshots. */
  resetDetected: boolean;
  /** Sum of totalMs across every entry — the denominator for share-of-time. */
  totalMs: number;
  entries: WorkloadEntry[];
}

export interface WorkloadAvailability {
  available: boolean;
  installed: boolean;
  reason: string | null;
  hint: string | null;
}

/** Whether pg_stat_statements is usable, and if not, why not. */
export async function probeWorkload(db: Database): Promise<WorkloadAvailability> {
  try {
    return await db.readOnlySession(async (client) => {
      const avail = await client.query<{ available: boolean; installed: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS available,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`,
      );
      const row = avail.rows[0];

      if (!row?.available) {
        return {
          available: false,
          installed: false,
          reason: 'pg_stat_statements is not available on this server.',
          hint: 'It ships with Postgres as a contrib module. On a managed provider it may need enabling in the parameter group.',
        };
      }
      if (!row.installed) {
        return {
          available: true,
          installed: false,
          reason: 'pg_stat_statements is available but not installed in this database.',
          hint: "Add it to shared_preload_libraries, restart, then run CREATE EXTENSION pg_stat_statements.",
        };
      }

      // Installed but not preloaded reads as installed and then errors on
      // select — check that it actually answers.
      try {
        await client.query('SELECT 1 FROM pg_stat_statements LIMIT 1');
      } catch (err) {
        return {
          available: true,
          installed: true,
          reason: 'pg_stat_statements is installed but not collecting.',
          hint: 'It must be listed in shared_preload_libraries, which requires a server restart to take effect.',
        };
      }

      return { available: true, installed: true, reason: null, hint: null };
    });
  } catch (err) {
    return {
      available: false,
      installed: false,
      reason: err instanceof Error ? err.message : String(err),
      hint: null,
    };
  }
}

/**
 * Column names changed in PG 13: total_time became total_exec_time. Detect
 * rather than assume, so the agent works against whatever it is pointed at.
 */
async function timeColumns(client: PoolClient): Promise<{ total: string; mean: string; stddev: string | null }> {
  const cols = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'pg_stat_statements'`,
  );
  const names = new Set(cols.rows.map((r) => r.column_name));

  return {
    total: names.has('total_exec_time') ? 'total_exec_time' : 'total_time',
    mean: names.has('mean_exec_time') ? 'mean_exec_time' : 'mean_time',
    stddev: names.has('stddev_exec_time')
      ? 'stddev_exec_time'
      : names.has('stddev_time')
        ? 'stddev_time'
        : null,
  };
}

/**
 * Read the current cumulative counters on an existing client.
 *
 * Split out from collectWorkload so the drop-index proof can harvest workload
 * texts inside its own single session — hypopg's hidden state is backend-local,
 * so that proof cannot afford a second connection.
 */
export async function collectWorkloadOn(client: PoolClient, limit = 200): Promise<WorkloadEntry[]> {
  const cols = await timeColumns(client);
  const stddev = cols.stddev ? `${cols.stddev}` : 'NULL';

  const result = await client.query<Record<string, string | number | null>>(
    `SELECT queryid::text          AS query_id,
            query,
            calls,
            ${cols.total}          AS total_ms,
            ${cols.mean}           AS mean_ms,
            ${stddev}              AS stddev_ms,
            rows,
            shared_blks_hit,
            shared_blks_read
     FROM pg_stat_statements
     WHERE queryid IS NOT NULL
     ORDER BY ${cols.total} DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    queryId: String(row['query_id']),
    query: String(row['query'] ?? ''),
    calls: Number(row['calls'] ?? 0),
    totalMs: Number(row['total_ms'] ?? 0),
    meanMs: Number(row['mean_ms'] ?? 0),
    stddevMs: row['stddev_ms'] === null ? null : Number(row['stddev_ms']),
    rows: Number(row['rows'] ?? 0),
    sharedHit: Number(row['shared_blks_hit'] ?? 0),
    sharedRead: Number(row['shared_blks_read'] ?? 0),
  }));
}

/** Read the current cumulative counters. */
export async function collectWorkload(db: Database, limit = 200): Promise<WorkloadEntry[]> {
  return db.readOnlySession((client) => collectWorkloadOn(client, limit));
}

/**
 * Delta two snapshots into "what happened between them".
 *
 * `previous` may be missing entirely (first snapshot) or missing individual
 * entries (eviction, or a query first seen in this window). Both are treated as
 * "all of it is new", which is the truthful reading — we know it ran at least
 * this much, and claiming otherwise would under-report.
 */
export function deltaWorkload(
  previous: WorkloadEntry[] | null,
  current: WorkloadEntry[],
): { entries: WorkloadEntry[]; resetDetected: boolean } {
  // Sorting happens once at the end, for every path. The SQL already orders by
  // total time, but a function that returns ranked results on one branch and
  // source order on another has no contract worth relying on.
  if (!previous) return { entries: byTotalTime(current), resetDetected: false };

  const before = new Map(previous.map((e) => [e.queryId, e]));
  const entries: WorkloadEntry[] = [];
  let resetDetected = false;

  for (const now of current) {
    const then = before.get(now.queryId);

    // No prior entry: first sighting, or it was evicted and came back. Either
    // way the current counters are the best available lower bound.
    if (!then) {
      entries.push(now);
      continue;
    }

    // Counters going backwards means a reset, not negative work.
    if (now.calls < then.calls || now.totalMs < then.totalMs) {
      resetDetected = true;
      entries.push(now);
      continue;
    }

    const calls = now.calls - then.calls;
    // A query that did not run in this window is not part of this window.
    if (calls === 0) continue;

    const totalMs = now.totalMs - then.totalMs;
    entries.push({
      queryId: now.queryId,
      query: now.query,
      calls,
      totalMs,
      meanMs: calls > 0 ? totalMs / calls : 0,
      // stddev cannot be delta'd meaningfully — it describes the whole
      // population, not the window. Carry the current value and label it.
      stddevMs: now.stddevMs,
      rows: Math.max(now.rows - then.rows, 0),
      sharedHit: Math.max(now.sharedHit - then.sharedHit, 0),
      sharedRead: Math.max(now.sharedRead - then.sharedRead, 0),
    });
  }

  return { entries: byTotalTime(entries), resetDetected };
}

/**
 * Total time, descending — the whole point.
 *
 * Ranking by mean surfaces the slow report nobody runs; ranking by total
 * surfaces what the server is actually spending its day on.
 */
function byTotalTime(entries: WorkloadEntry[]): WorkloadEntry[] {
  return [...entries].sort((a, b) => b.totalMs - a.totalMs);
}

export type WorkloadFlag = 'dominant' | 'high-frequency' | 'unstable' | 'cold-cache';

export interface RankedEntry extends WorkloadEntry {
  /** Fraction of the window's total time. */
  share: number;
  flags: WorkloadFlag[];
  /** Plain-English reason this entry is worth looking at, or null. */
  note: string | null;
}

/**
 * Annotate a window with what is worth noticing.
 *
 * The interesting signal is rarely "this one is slow" — it is "this one is
 * cheap and constant", or "this one's runtime is all over the place, which
 * means its plan is".
 */
export function rankWorkload(entries: WorkloadEntry[]): { ranked: RankedEntry[]; totalMs: number } {
  const totalMs = entries.reduce((sum, e) => sum + e.totalMs, 0);

  const ranked = entries.map((entry) => {
    const share = totalMs > 0 ? entry.totalMs / totalMs : 0;
    const flags: WorkloadFlag[] = [];

    if (share >= 0.2) flags.push('dominant');
    // Fast individually, expensive in aggregate — the case a slow-query log
    // cannot see at all.
    if (entry.meanMs < 10 && entry.calls > 1000 && share >= 0.05) flags.push('high-frequency');
    // Runtime varying more than its own mean usually means the plan is not
    // stable across parameter values.
    if (entry.stddevMs !== null && entry.meanMs > 0 && entry.stddevMs > entry.meanMs) {
      flags.push('unstable');
    }
    const blocks = entry.sharedHit + entry.sharedRead;
    if (blocks > 10_000 && entry.sharedRead / blocks > 0.5) flags.push('cold-cache');

    return { ...entry, share, flags, note: noteFor(entry, flags, share) };
  });

  return { ranked, totalMs };
}

function noteFor(entry: WorkloadEntry, flags: WorkloadFlag[], share: number): string | null {
  if (flags.includes('high-frequency')) {
    return (
      `${formatCount(entry.calls)} calls at ${entry.meanMs.toFixed(1)}ms each. ` +
      `Individually fast, but ${(share * 100).toFixed(0)}% of all query time — this is the kind of query a slow-query log never shows you.`
    );
  }
  if (flags.includes('unstable')) {
    return (
      `Runtime varies more than its own average (±${(entry.stddevMs ?? 0).toFixed(0)}ms on a ${entry.meanMs.toFixed(0)}ms mean). ` +
      'That usually means the plan changes with the parameter values.'
    );
  }
  if (flags.includes('dominant')) {
    return `${(share * 100).toFixed(0)}% of all query time in this window.`;
  }
  if (flags.includes('cold-cache')) {
    return 'Most of its block reads miss the buffer cache — its working set is larger than what stays resident.';
  }
  return null;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Whether a normalised query can be EXPLAINed as-is.
 *
 * pg_stat_statements replaces literals with $1 placeholders, and EXPLAIN
 * cannot plan a statement whose parameters are unknown. This is the parameter
 * problem from §6.1, and the honest thing is to detect it and say so rather
 * than fail with a confusing syntax error.
 */
export function isExplainable(query: string): { ok: boolean; reason: string | null } {
  if (/\$\d+/.test(query)) {
    return {
      ok: false,
      reason:
        'This is the normalised form — pg_stat_statements replaces literals with $1 placeholders, and a plan depends on the actual values. ' +
        'Substitute representative parameters to analyse it.',
    };
  }
  if (query.trim().endsWith('...')) {
    return { ok: false, reason: 'Query text was truncated by pg_stat_statements (track_activity_query_size).' };
  }
  return { ok: true, reason: null };
}
