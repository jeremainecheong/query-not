/**
 * Proving an index is safe to DROP.
 *
 * The mirror image of whatIfIndex: instead of adding a hypothetical index and
 * asking "would the planner use it?", hypopg 1.4's hypopg_hide_index removes an
 * existing one from the planner's view and asks "does anything get worse?". Same
 * house loop — perturb the world, re-plan, diff — pointed at deletion.
 *
 * Two halves, mirroring catalog.ts:
 *
 *   1. An inventory (pure probe builder + pure interpreter) listing every user
 *      index with its usage evidence, and flagging the ones that enforce
 *      semantics — primary keys, unique/exclusion constraints, replica
 *      identities, FK-referenced indexes — as not droppable *for performance*.
 *      Dropping those is a schema change, and no plan diff can bless it.
 *
 *   2. A proof: hide the index in ONE read-only session, re-EXPLAIN the set of
 *      queries this agent actually knows about (recorded analyses first, then
 *      admissible pg_stat_statements entries), diff every plan, and issue a
 *      verdict that claims safety only against those enumerated queries —
 *      the only honest claim a tool that cannot see every client can make.
 */

import { diffPlans, parseExplainJson, type QueryPlan, type Verdict } from '@query-not/core';

import { trySavepoint, type Database } from './db.ts';
import type { Store } from './store.ts';
import { AgentError } from './explain.ts';
import { admitQuery, fingerprint } from './safety.ts';
import { collectWorkloadOn, isExplainable } from './workload.ts';
import { quoteIdent } from './transform.ts';

/**
 * Bounded latency over coverage: each proof query costs two EXPLAINs inside the
 * session's statement timeout. The cap is disclosed in coverage.cap and the
 * note, so a truncated proof set never looks exhaustive.
 */
export const MAX_PROOF_QUERIES = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexDisqualifier {
  kind: 'primary-key' | 'unique' | 'exclusion-constraint' | 'replica-identity' | 'constraint-backing';
  /** The citable sentence: backtick-quoted identifiers, catalog column named. */
  evidence: string;
}

export interface IndexInventoryEntry {
  schema: string;
  table: string;
  index: string;
  definition: string;
  sizeBytes: number;
  scans: number;
  /** Only populated on PG 16+, where pg_stat_user_indexes grew last_idx_scan. */
  lastScanAt: string | null;
  /** False for the residue of a failed CREATE INDEX CONCURRENTLY. */
  valid: boolean;
  /** False iff disqualifiers is non-empty — the index enforces semantics. */
  droppableForPerformance: boolean;
  disqualifiers: IndexDisqualifier[];
  /** The usage sentence with the idx_scan caveats, or the invalid-index fact. */
  evidence: string;
}

export interface IndexInventory {
  statsResetAt: string | null;
  hasLastScan: boolean;
  /** Page-level framing of what idx_scan can and cannot see. */
  statsNote: string;
  indexes: IndexInventoryEntry[];
}

export interface ProofQuery {
  sql: string;
  fingerprint: string;
  source: 'store' | 'workload';
}

export interface ProofSetSkip {
  source: 'store' | 'workload';
  fingerprint: string | null;
  reason: string;
}

export interface PerQueryDropResult {
  fingerprint: string;
  sql: string;
  source: 'store' | 'workload';
  /** Whether the before-plan actually scanned the index being proven. */
  usedIndex: boolean;
  verdict: Verdict | null;
  headline: string | null;
  costBefore: number | null;
  costAfter: number | null;
  costChange: number | null;
  accessChanges: string[];
  /** Set when the query could not be planned (e.g. its table was dropped). */
  error: string | null;
}

export type DropOutcome = 'no-plan-changed' | 'plans-changed-not-worse' | 'regressed';

export interface DropIndexProof {
  index: { schema: string; table: string; name: string; definition: string; sizeBytes: number };
  usage: {
    scans: number | null;
    lastScanAt: string | null;
    statsResetAt: string | null;
    evidence: string;
  };
  perQuery: PerQueryDropResult[];
  coverage: {
    tested: number;
    fromStore: number;
    fromWorkload: number;
    skipped: ProofSetSkip[];
    capped: boolean;
    cap: number;
  };
  outcome: DropOutcome;
  /** Always true: only plain EXPLAIN runs — hiding changes planner visibility. */
  costOnly: true;
  note: string;
}

// ── Pure probe builders ──────────────────────────────────────────────────────

/**
 * pg_stat_user_indexes gained last_idx_scan in PG 16. Probed via pg_attribute
 * on the view's regclass — the guaranteed catalog path — rather than assumed
 * from a version string, per the workload.ts detect-don't-assume idiom.
 */
export const LAST_SCAN_PROBE =
  `SELECT EXISTS (SELECT 1 FROM pg_attribute ` +
  `WHERE attrelid = 'pg_catalog.pg_stat_user_indexes'::regclass ` +
  `AND attname = 'last_idx_scan' AND NOT attisdropped) AS has_last_scan`;

export const STATS_RESET_PROBE =
  `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`;

/**
 * Every user index, its counters, and the constraint facts that disqualify it.
 *
 * The pg_constraint join is a LATERAL array_agg so several constraints on one
 * index (a unique index referenced by many foreign keys) still produce exactly
 * one row. Ordered scans ASC then size DESC: the biggest never-scanned index is
 * the most interesting candidate, so it comes first.
 */
export function buildIndexInventoryProbe(hasLastScan: boolean): { text: string } {
  const lastScan = hasLastScan ? 's.last_idx_scan' : 'NULL::timestamptz';
  return {
    text: `
      SELECT s.schemaname AS schema,
             s.relname AS "table",
             s.indexrelname AS index,
             s.idx_scan::bigint AS scans,
             ${lastScan} AS last_scan_at,
             pg_relation_size(s.indexrelid) AS size_bytes,
             pg_get_indexdef(s.indexrelid) AS definition,
             i.indisunique AS is_unique,
             i.indisprimary AS is_primary,
             i.indisvalid AS is_valid,
             i.indisreplident AS is_replident,
             con.names AS constraint_names,
             con.types AS constraint_types
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      LEFT JOIN LATERAL (
        SELECT array_agg(c.conname::text ORDER BY c.conname) AS names,
               array_agg(c.contype::text  ORDER BY c.conname) AS types
        FROM pg_constraint c WHERE c.conindid = s.indexrelid
      ) con ON true
      ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC
      LIMIT 200
    `,
  };
}

/**
 * Resolve one index inside the proof session. $1 is the quoteIdent-composed
 * name, passed as a bind parameter to to_regclass — never interpolated — and
 * resolved through the session's search_path, the same doctrine as catalog.ts.
 * The oid this returns is the oid that gets hidden, in the same session.
 */
export function buildIndexResolveProbe(hasLastScan: boolean): { text: string } {
  const lastScan = hasLastScan ? 's.last_idx_scan' : 'NULL::timestamptz';
  return {
    text: `
      SELECT c.oid::bigint AS index_oid,
             n.nspname AS schema,
             t.relname AS "table",
             c.relname AS index,
             pg_get_indexdef(c.oid) AS definition,
             pg_relation_size(c.oid) AS size_bytes,
             i.indisunique AS is_unique,
             i.indisprimary AS is_primary,
             i.indisvalid AS is_valid,
             i.indisreplident AS is_replident,
             s.idx_scan::bigint AS scans,
             ${lastScan} AS last_scan_at,
             con.names AS constraint_names,
             con.types AS constraint_types
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = c.oid
      LEFT JOIN LATERAL (
        SELECT array_agg(x.conname::text ORDER BY x.conname) AS names,
               array_agg(x.contype::text  ORDER BY x.conname) AS types
        FROM pg_constraint x WHERE x.conindid = c.oid
      ) con ON true
      WHERE c.oid = to_regclass($1)
    `,
  };
}

// ── Pure interpretation ──────────────────────────────────────────────────────

/** The flag columns shared by the inventory and resolve probes. */
export interface IndexFlagsRow {
  is_unique: boolean;
  is_primary: boolean;
  is_valid: boolean;
  is_replident: boolean;
  constraint_names: string[] | null;
  constraint_types: string[] | null;
}

export interface IndexInventoryRow extends IndexFlagsRow {
  schema: string;
  table: string;
  index: string;
  scans: string | number | null;
  last_scan_at: string | Date | null;
  size_bytes: string | number;
  definition: string;
}

/** pg returns bigint as string and timestamptz as Date; normalise both. */
const toCount = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

const toIso = (v: string | Date | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

/**
 * The facts that make an index un-droppable for performance reasons.
 *
 * These enforce semantics, not speed: hiding one and finding no plan changed
 * proves nothing about the constraint it guards, which is why the prove
 * endpoint refuses them outright rather than issuing a verdict.
 */
export function disqualifiersFor(index: string, table: string, row: IndexFlagsRow): IndexDisqualifier[] {
  const out: IndexDisqualifier[] = [];

  if (row.is_primary) {
    out.push({
      kind: 'primary-key',
      evidence:
        `\`${index}\` enforces the primary key on \`${table}\` (pg_index.indisprimary) — ` +
        'it guards row identity, not speed; dropping it is a schema change, not an optimisation.',
    });
  } else if (row.is_unique) {
    out.push({
      kind: 'unique',
      evidence:
        `\`${index}\` enforces uniqueness on \`${table}\` (pg_index.indisunique) — ` +
        'without it duplicate rows become legal, which is a semantics change, not an optimisation.',
    });
  }

  const names = row.constraint_names ?? [];
  const types = row.constraint_types ?? [];
  for (let i = 0; i < types.length; i++) {
    const name = names[i] ?? '(unnamed)';
    // 'p' is already covered by indisprimary above; repeating it adds nothing.
    if (types[i] === 'x') {
      out.push({
        kind: 'exclusion-constraint',
        evidence:
          `exclusion constraint \`${name}\` is enforced by \`${index}\` (pg_constraint.contype = 'x') — ` +
          'dropping the index drops the guarantee, not just an access path.',
      });
    }
  }

  if (row.is_replident) {
    out.push({
      kind: 'replica-identity',
      evidence:
        `\`${index}\` is the replica identity for \`${table}\` (pg_index.indisreplident) — ` +
        'logical replication identifies rows through it; dropping it changes replication, not performance.',
    });
  }

  for (let i = 0; i < types.length; i++) {
    const name = names[i] ?? '(unnamed)';
    if (types[i] === 'f') {
      out.push({
        kind: 'constraint-backing',
        evidence:
          `foreign key \`${name}\` depends on it (pg_constraint.conindid) — ` +
          'the reference is validated through this index.',
      });
    } else if (types[i] === 'u') {
      out.push({
        kind: 'constraint-backing',
        evidence:
          `unique constraint \`${name}\` owns it (pg_constraint.conindid) — ` +
          'DROP INDEX would be refused while the constraint stands.',
      });
    }
  }

  return out;
}

/**
 * The usage sentence, with the counter's blind spots stated every time.
 *
 * idx_scan is evidence, never a verdict: it counts since the last statistics
 * reset (or forever, when stats_reset is NULL), on this server only — replicas
 * keep their own counters — and constraint enforcement never increments it.
 */
export function usageEvidence(
  index: string,
  scans: number | null,
  ctx: { statsResetAt: string | null; hasLastScan: boolean },
  lastScanAt: string | null,
): string {
  if (scans === null) {
    return `\`${index}\` has no row in pg_stat_user_indexes, so no usage counter is available for it.`;
  }
  const since = ctx.statsResetAt
    ? `since statistics were last reset (pg_stat_user_indexes.idx_scan; reset ${ctx.statsResetAt})`
    : `since this database's statistics began (pg_stat_user_indexes.idx_scan; stats_reset is NULL)`;
  let sentence =
    `\`${index}\` has ${scans} scan${scans === 1 ? '' : 's'} ${since} — ` +
    'the counter cannot see usage before a reset, reads served by replicas, or constraint enforcement.';
  if (ctx.hasLastScan && lastScanAt) {
    sentence += ` Last scanned ${lastScanAt} (last_idx_scan).`;
  }
  return sentence;
}

const invalidEvidence = (index: string): string =>
  `\`${index}\` is marked invalid (pg_index.indisvalid = false), usually the residue of a failed ` +
  'CREATE INDEX CONCURRENTLY. The planner never uses an invalid index, so dropping it cannot ' +
  'change any plan — it only reclaims the space and the maintenance cost.';

function composeStatsNote(statsResetAt: string | null): string {
  const window = statsResetAt
    ? `since the last statistics reset (${statsResetAt})`
    : `since this database's statistics began (pg_stat_database.stats_reset is NULL)`;
  return (
    `Scan counts come from pg_stat_user_indexes.idx_scan, counting ${window}. ` +
    'The counter cannot see usage before a reset, reads served by replicas, or the constraint ' +
    'enforcement an index does without being scanned — 0 scans is evidence, never a verdict. ' +
    'Verdicts come only from the prove loop, and only over the queries this agent knows about.'
  );
}

/** Turn inventory rows into entries. Row order (scans ASC, size DESC) is kept. */
export function interpretIndexInventory(
  rows: IndexInventoryRow[],
  ctx: { statsResetAt: string | null; hasLastScan: boolean },
): IndexInventoryEntry[] {
  return rows.map((row) => {
    const scans = toCount(row.scans) ?? 0;
    const lastScanAt = ctx.hasLastScan ? toIso(row.last_scan_at) : null;
    const disqualifiers = disqualifiersFor(row.index, row.table, row);
    return {
      schema: row.schema,
      table: row.table,
      index: row.index,
      definition: row.definition,
      sizeBytes: Number(row.size_bytes),
      scans,
      lastScanAt,
      valid: row.is_valid,
      droppableForPerformance: disqualifiers.length === 0,
      disqualifiers,
      evidence: row.is_valid
        ? usageEvidence(row.index, scans, ctx, lastScanAt)
        : invalidEvidence(row.index),
    };
  });
}

// ── Proof-set assembly ───────────────────────────────────────────────────────

/**
 * The queries the verdict will be issued over.
 *
 * Store entries first — they are what users actually analysed, already deduped
 * by fingerprint via queryGroups — then workload texts. Everything is
 * re-admitted here: stored SQL is as untrusted as fresh input, and
 * pg_stat_statements text is normalised ($1 placeholders cannot be planned, so
 * isExplainable filters those with the stated reason). Every exclusion becomes
 * a ProofSetSkip, because silent shrinkage would make thin coverage look full.
 */
export function assembleProofSet(
  fromStore: Array<{ fingerprint: string; sql: string }>,
  fromWorkload: string[],
  cap: number = MAX_PROOF_QUERIES,
): { queries: ProofQuery[]; skipped: ProofSetSkip[]; capped: boolean } {
  const queries: ProofQuery[] = [];
  const skipped: ProofSetSkip[] = [];
  const seen = new Set<string>();
  let capped = false;

  const admit = (sql: string, source: 'store' | 'workload', fp: string): void => {
    if (seen.has(fp)) {
      skipped.push({
        source,
        fingerprint: fp,
        reason: 'Duplicate of a query already in the proof set (same fingerprint).',
      });
      return;
    }
    const admission = admitQuery(sql);
    if (!admission.ok) {
      skipped.push({ source, fingerprint: fp, reason: admission.reason ?? 'Query refused.' });
      return;
    }
    if (queries.length >= cap) {
      capped = true;
      skipped.push({ source, fingerprint: fp, reason: `Over the proof-set cap of ${cap} queries.` });
      return;
    }
    seen.add(fp);
    queries.push({ sql, fingerprint: fp, source });
  };

  for (const q of fromStore) admit(q.sql, 'store', q.fingerprint);

  for (const text of fromWorkload) {
    const explainable = isExplainable(text);
    if (!explainable.ok) {
      skipped.push({
        source: 'workload',
        fingerprint: fingerprint(text),
        reason: explainable.reason ?? 'Not explainable.',
      });
      continue;
    }
    admit(text, 'workload', fingerprint(text));
  }

  return { queries, skipped, capped };
}

// ── Verdict ──────────────────────────────────────────────────────────────────

/**
 * Any regression condemns the drop; any other change demands a look; only a
 * completely still surface reads as "no plan changed". Error rows carry no
 * verdict and are excluded here — they are disclosed in the note instead.
 */
/**
 * Did every query in the proof set fail to plan? Then nothing was tested and
 * no verdict — least of all a green one — may be issued. The orchestrator
 * refuses on this; dropVerdict itself only classifies the verdicts that exist.
 */
export function everyQueryErrored(perQuery: PerQueryDropResult[]): boolean {
  return perQuery.length > 0 && perQuery.every((q) => q.verdict === null);
}

export function dropVerdict(perQuery: PerQueryDropResult[]): DropOutcome {
  const verdicts = perQuery
    .map((q) => q.verdict)
    .filter((v): v is Verdict => v !== null);
  if (verdicts.includes('regressed')) return 'regressed';
  if (verdicts.some((v) => v === 'improved' || v === 'restructured')) {
    return 'plans-changed-not-worse';
  }
  return 'no-plan-changed';
}

const truncateSql = (sql: string, max = 90): string => {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * The verdict sentence, citing its evidence.
 *
 * Every variant carries the "queries this agent knows about" framing — the
 * proof enumerates its coverage rather than implying totality — and the
 * estimate disclaimer, because only plain EXPLAIN ever ran.
 */
export function composeDropNote(
  index: { name: string },
  usage: { evidence: string },
  perQuery: PerQueryDropResult[],
  coverage: { tested: number; fromStore: number; fromWorkload: number; capped: boolean; cap: number },
  outcome: DropOutcome,
): string {
  const errors = perQuery.filter((q) => q.error !== null).length;
  const tested =
    `the ${coverage.tested} ${coverage.tested === 1 ? 'query' : 'queries'} this agent knows about ` +
    `(${coverage.fromStore} from history, ${coverage.fromWorkload} from the workload` +
    (coverage.capped ? `; capped at ${coverage.cap}` : '') +
    ')';
  const errNote =
    errors > 0
      ? ` ${errors} of ${coverage.tested} could not be planned and ${errors === 1 ? 'was' : 'were'} excluded from the verdict.`
      : '';
  const estimates =
    'Planner cost estimates only — the index was hidden (hypopg_hide_index), not dropped, and nothing was executed.';

  if (outcome === 'regressed') {
    const worst = perQuery
      .filter((q) => q.verdict === 'regressed')
      .sort((a, b) => (b.costChange ?? 0) - (a.costChange ?? 0))[0];
    const cost =
      worst && worst.costBefore !== null && worst.costAfter !== null
        ? ` — cost ${worst.costBefore.toFixed(0)} → ${worst.costAfter.toFixed(0)}` +
          (worst.costChange !== null ? ` (${worst.costChange >= 0 ? '+' : ''}${(worst.costChange * 100).toFixed(0)}%)` : '')
        : '';
    const access = worst && worst.accessChanges[0] ? `, ${worst.accessChanges[0]}` : '';
    return (
      `\`${index.name}\` is load-bearing: with it hidden (hypopg_hide_index), ` +
      `\`${truncateSql(worst?.sql ?? '')}\` regresses${cost}${access}. ` +
      `Tested against ${tested}.${errNote} ${estimates} Do not drop it.`
    );
  }

  if (outcome === 'plans-changed-not-worse') {
    const changed = perQuery.filter((q) => q.verdict === 'improved' || q.verdict === 'restructured');
    const example = changed.find((q) => q.accessChanges.length > 0)?.accessChanges[0];
    return (
      `Hiding \`${index.name}\` (hypopg_hide_index) changed ${changed.length} ` +
      `plan${changed.length === 1 ? '' : 's'}, none for the worse` +
      (example ? ` — ${example}` : '') +
      `. Another access path absorbed the work across ${tested}.${errNote} ` +
      `Review the changed plans before dropping; queries never analysed here are not covered. ${estimates}`
    );
  }

  return (
    `Hiding \`${index.name}\` (hypopg_hide_index; confirmed in hypopg_hidden_indexes during the ` +
    `re-plan) changed no plan across ${tested}.${errNote} ${usage.evidence} ` +
    `Safe to drop against these queries; queries never analysed here are not covered. ${estimates}`
  );
}

// ── Orchestrators ────────────────────────────────────────────────────────────

/**
 * The inventory. Needs no extension at all — it reads the statistics and the
 * catalog, so it works (and the page renders) on databases without hypopg;
 * only the prove button is capability-gated.
 */
export async function listIndexInventory(db: Database): Promise<IndexInventory> {
  return db.readOnlySession(async (client) => {
    const hasLastScan =
      (await client.query<{ has_last_scan: boolean }>(LAST_SCAN_PROBE)).rows[0]?.has_last_scan === true;
    const reset = await client.query<{ stats_reset: string | Date | null }>(STATS_RESET_PROBE);
    const statsResetAt = toIso(reset.rows[0]?.stats_reset ?? null);

    const probe = buildIndexInventoryProbe(hasLastScan);
    const rows = (await client.query<IndexInventoryRow>(probe.text)).rows;

    return {
      statsResetAt,
      hasLastScan,
      statsNote: composeStatsNote(statsResetAt),
      indexes: interpretIndexInventory(rows, { statsResetAt, hasLastScan }),
    };
  });
}

interface IndexResolveRow extends IndexFlagsRow {
  index_oid: string | number;
  schema: string;
  table: string;
  index: string;
  definition: string;
  size_bytes: string | number;
  scans: string | number | null;
  last_scan_at: string | Date | null;
}

/**
 * Hide the index, re-plan everything this agent knows, diff, and conclude.
 *
 * The whole thing runs in ONE readOnlySession because hypopg's hidden state is
 * backend-local: hiding on one pooled connection and explaining on another
 * would prove nothing. The same locality is also the hazard — see the finally.
 */
export async function proveDropIndex(
  db: Database,
  store: Store,
  indexName: string,
  schema: string | null,
): Promise<DropIndexProof> {
  if (typeof indexName !== 'string' || indexName.trim().length === 0 || indexName.length > 200) {
    throw new AgentError('Provide an "index" name — a bare identifier of at most 200 characters.');
  }
  if (schema !== null && (typeof schema !== 'string' || schema.trim().length === 0 || schema.length > 200)) {
    throw new AgentError('"schema", when given, must be a non-empty string of at most 200 characters.');
  }

  // quoteIdent composition happens server-side so mixed-case names survive, and
  // the composed text only ever reaches the database as a bind parameter to
  // to_regclass($1) — no client-sent SQL, no client-sent oid.
  const target = schema
    ? `${quoteIdent(schema)}.${quoteIdent(indexName)}`
    : quoteIdent(indexName);

  // The store is SQLite beside the agent, not the customer's database — read it
  // before the Postgres session opens so the session is exactly as long as the
  // proof itself.
  const fromStore = store
    .queryGroups(50)
    .map((g) => ({ fingerprint: g.fingerprint, sql: g.sql }));

  return db.readOnlySession(async (client) => {
    // Identical statement and refusal to whatIfIndex — the two features share
    // the extension, so they must share the explanation.
    const installed = await client.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'hypopg') AS installed`,
    );
    if (!installed.rows[0]?.installed) {
      throw new AgentError(
        'The hypopg extension is not installed on this database.',
        'Run CREATE EXTENSION hypopg. On managed providers it may not be offered at all — in that case use a shadow database, ' +
          'where the agent controls what is installed.',
        412,
      );
    }

    // Capability by function existence, never by parsing a version string.
    const canHide = await client.query<{ can_hide: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'hypopg_hide_index') AS can_hide`,
    );
    if (!canHide.rows[0]?.can_hide) {
      throw new AgentError(
        'hypopg is installed but predates index hiding (added in 1.4.0).',
        'ALTER EXTENSION hypopg UPDATE, or install hypopg >= 1.4.0.',
        412,
      );
    }

    try {
      const hasLastScan =
        (await client.query<{ has_last_scan: boolean }>(LAST_SCAN_PROBE)).rows[0]?.has_last_scan === true;
      const statsResetAt = toIso(
        (await client.query<{ stats_reset: string | Date | null }>(STATS_RESET_PROBE)).rows[0]?.stats_reset ??
          null,
      );

      const resolve = buildIndexResolveProbe(hasLastScan);
      const row = (await client.query<IndexResolveRow>(resolve.text, [target])).rows[0];
      if (!row) {
        throw new AgentError(
          `No index named \`${target}\` resolves in this database's search_path.`,
          'Use the name exactly as GET /api/indexes lists it, and pass "schema" when it lives outside the search_path.',
          404,
        );
      }

      // Disqualifiers are re-established in THIS session: the inventory a
      // client saw is another request's catalog, and catalog facts are never
      // cached across requests.
      const disqualifiers = disqualifiersFor(row.index, row.table, row);
      if (disqualifiers.length > 0) {
        throw new AgentError(
          `${disqualifiers.map((d) => d.evidence).join(' ')} ` +
            'Hiding it proves nothing about the constraint it enforces — this is a refusal, not a verdict.',
          null,
          409,
        );
      }

      // Harvest what the server itself has been running, on this same client.
      // Any failure degrades to store-only coverage with a disclosed skip —
      // a broken pg_stat_statements must not fail the proof.
      let fromWorkload: string[] = [];
      const harvestSkips: ProofSetSkip[] = [];
      try {
        const pss = await client.query<{ installed: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`,
        );
        if (pss.rows[0]?.installed) {
          fromWorkload = (await collectWorkloadOn(client, 50)).map((e) => e.query);
        }
      } catch (err) {
        harvestSkips.push({
          source: 'workload',
          fingerprint: null,
          reason: `Workload harvest failed: ${err instanceof Error ? err.message : String(err)}. The proof ran against stored analyses only.`,
        });
      }

      const set = assembleProofSet(fromStore, fromWorkload, MAX_PROOF_QUERIES);
      const skipped = [...harvestSkips, ...set.skipped];
      if (set.queries.length === 0) {
        throw new AgentError(
          'No admissible queries are known, and a verdict over zero queries would be a guess.',
          'Analyse the queries that matter (every analysis is recorded), or take a workload snapshot, then prove again.',
          412,
        );
      }

      const explain = async (text: string): Promise<QueryPlan> => {
        const res = await client.query<Record<string, unknown>>(
          `EXPLAIN (FORMAT JSON) ${text.trim().replace(/;\s*$/, '')}`,
        );
        const first = res.rows[0];
        if (!first) throw new AgentError('EXPLAIN returned no rows.', null, 500);
        return parseExplainJson(Object.values(first)[0] as unknown, text);
      };

      // Before-plans, one savepoint per query: a stored query whose table has
      // since vanished becomes an error row, not a failed proof. Without the
      // savepoint its failure aborts the whole transaction, so every later
      // statement — the remaining plans, the hide, and the unhide cleanup —
      // fails with 25P02 and the proof collapses into a meaningless error.
      const befores: Array<{ q: ProofQuery; plan: QueryPlan | null; error: string | null }> = [];
      for (const q of set.queries) {
        const r = await trySavepoint(client, () => explain(q.sql));
        befores.push(
          r.ok
            ? { q, plan: r.value, error: null }
            : { q, plan: null, error: r.error instanceof Error ? r.error.message : String(r.error) },
        );
      }

      const hidden = await client.query<{ hidden: boolean }>(
        'SELECT hypopg_hide_index($1::oid) AS hidden',
        [row.index_oid],
      );
      if (hidden.rows[0]?.hidden !== true) {
        throw new AgentError(`hypopg declined to hide \`${row.index}\`.`, null, 500);
      }
      // Read the hiding back from hypopg's own view, so the note cites the
      // extension's word for it rather than our own success flag.
      const nowHidden = await client.query<{ index: string }>(
        `SELECT indexrelid::regclass::text AS index FROM hypopg_hidden_indexes`,
      );
      if (nowHidden.rows.length === 0) {
        throw new AgentError(
          `hypopg reported \`${row.index}\` hidden, but hypopg_hidden_indexes lists nothing.`,
          null,
          500,
        );
      }

      const perQuery: PerQueryDropResult[] = [];
      for (const b of befores) {
        const base = { fingerprint: b.q.fingerprint, sql: b.q.sql, source: b.q.source };
        if (!b.plan) {
          perQuery.push({
            ...base,
            usedIndex: false,
            verdict: null,
            headline: null,
            costBefore: null,
            costAfter: null,
            costChange: null,
            accessChanges: [],
            error: b.error,
          });
          continue;
        }
        const usedIndex = b.plan.nodes.some((n) => n.indexName === row.index);
        // Same savepoint discipline for the after-plan: one query that fails to
        // re-plan with the index hidden must not abort the transaction and
        // strand the hidden index on this pooled connection.
        const r = await trySavepoint(client, () => explain(b.q.sql));
        if (r.ok) {
          const diff = diffPlans(b.plan, r.value);
          perQuery.push({
            ...base,
            usedIndex,
            verdict: diff.summary.verdict,
            headline: diff.summary.headline,
            costBefore: diff.summary.costBefore,
            costAfter: diff.summary.costAfter,
            costChange: diff.summary.costChange,
            accessChanges: diff.summary.accessChanges,
            error: null,
          });
        } else {
          perQuery.push({
            ...base,
            usedIndex,
            verdict: null,
            headline: null,
            costBefore: null,
            costAfter: null,
            costChange: null,
            accessChanges: [],
            error: r.error instanceof Error ? r.error.message : String(r.error),
          });
        }
      }

      const scans = toCount(row.scans);
      const lastScanAt = hasLastScan ? toIso(row.last_scan_at) : null;
      const usage = {
        scans,
        lastScanAt,
        statsResetAt,
        evidence: usageEvidence(row.index, scans, { statsResetAt, hasLastScan }, lastScanAt),
      };
      const coverage = {
        tested: perQuery.length,
        fromStore: set.queries.filter((q) => q.source === 'store').length,
        fromWorkload: set.queries.filter((q) => q.source === 'workload').length,
        skipped,
        capped: set.capped,
        cap: MAX_PROOF_QUERIES,
      };
      // Every query errored: nothing was actually re-planned, so there is no
      // verdict to give. dropVerdict would fall through to 'no-plan-changed',
      // whose note reads "safe to drop" — a green verdict computed from zero
      // evidence. Refuse instead; a proof that proved nothing is not a pass.
      if (everyQueryErrored(perQuery)) {
        throw new AgentError(
          `Could not test whether \`${row.index}\` is safe to drop: all ${perQuery.length} ` +
            'queries in the proof set failed to plan. The index may still be in use — this is ' +
            'not a verdict.',
          'Re-run once the failing queries plan cleanly, or narrow the proof set.',
          422,
        );
      }
      const outcome = dropVerdict(perQuery);

      return {
        index: {
          schema: row.schema,
          table: row.table,
          name: row.index,
          definition: row.definition,
          sizeBytes: Number(row.size_bytes),
        },
        usage,
        perQuery,
        coverage,
        outcome,
        costOnly: true as const,
        note: composeDropNote({ name: row.index }, usage, perQuery, coverage, outcome),
      };
    } finally {
      // Hidden indexes live in backend memory for the whole session, not the
      // transaction — ROLLBACK does not clear them. Without this the pooled
      // connection would keep planning without the index for every later
      // request, silently falsifying their analyses.
      //
      // The savepoints above keep the transaction alive, so this normally runs
      // clean. But if the hide statement itself aborted the transaction, the
      // unhide fails with 25P02 — and hypopg's hidden list survives ROLLBACK,
      // so cleanup must not depend on the transaction. Roll back to a clean
      // state and unhide in autocommit as the backstop.
      try {
        await client.query('SELECT hypopg_unhide_all_indexes()');
      } catch {
        try {
          await client.query('ROLLBACK');
          await client.query('SELECT hypopg_unhide_all_indexes()');
        } catch {
          // The connection is unusable; readOnlySession releases it, and a
          // dead backend clears its own hypopg state. Nothing leaks past here.
        }
      }
    }
  });
}
