/**
 * Workload-level index consolidation — orchestration.
 *
 * The core module merges demands into candidates; this module supplies the
 * demands and then makes the candidates earn their claims. Scope comes from
 * the same window GET /api/workload shows (never auto-snapshotted here — a
 * proof endpoint should not have a first-visit convenience as a side effect),
 * demands come from plain EXPLAIN (never ANALYZE: executing the top of
 * someone's workload as a side effect of a button is out of the question), and
 * every candidate is re-planned via the existing `whatIfIndex` against every
 * in-scope statement — claimed ones to prove service, unclaimed ones as
 * regression sentinels, because "regresses none" is only claimable if the
 * non-claimed queries were re-planned too.
 */

import {
  consolidateDemands,
  extractIndexDemands,
  formatPercent,
  type ConsolidatedIndex,
  type WeightedDemand,
} from '@query-not/core';

import type { Database } from './db.ts';
import { describeDbError } from './db.ts';
import { AgentError, runExplain, whatIfIndex } from './explain.ts';
import { admitQuery, fingerprint } from './safety.ts';
import type { SavedQuery, Store } from './store.ts';
import {
  deltaWorkload,
  isExplainable,
  probeWorkload,
  rankWorkload,
  type RankedEntry,
  type WorkloadEntry,
} from './workload.ts';

/**
 * The key used to match a workload entry to a saved query.
 *
 * `fingerprint` replaces literals and numbers with '?', lowercases, and
 * collapses whitespace — so a saved query with real literals and
 * pg_stat_statements' normalised text land on the same string. Two extra
 * folds on top, matching only, never stored:
 *
 *   - fingerprint's number pass runs before its $N pass, so a `$1` placeholder
 *     comes out as `$?` while a literal comes out as `?`. Folding `$?` to `?`
 *     here makes the two normalisations meet without touching the identity
 *     function history and decisions are keyed by.
 *   - stripping the remaining whitespace absorbs spacing differences such as
 *     `IN ($1,$2)` vs `IN (1, 2)`.
 */
export function matchKey(sql: string): string {
  return fingerprint(sql).replace(/\$\?/g, '?').replace(/\s+/g, '');
}

export interface ScopeMember {
  source: 'workload' | 'saved-matched' | 'saved-extra';
  /** The text that actually gets planned. */
  sql: string;
  /** Share of the whole window's time. Saved extras carry 0 — outside the window. */
  share: number;
  queryId: string | null;
  savedName: string | null;
  /** fingerprint(sql) of the planned text — the scope's dedupe key. */
  fingerprint: string;
}

export interface SkippedEntry {
  queryId: string | null;
  savedName: string | null;
  share: number;
  reason: string;
  hint: string | null;
}

/**
 * Coverage of the saved-query contribution to scope.
 *
 * The window path is bounded by the request-validated `limit`; the saved-extra
 * path must be bounded by the same number, or an unbounded saved set drives an
 * unbounded C×Q proof matrix. `cap` is that bound, `included` the extras that
 * made it into scope, `omitted` the admissible extras the cap left out — never
 * silently, so a truncated saved set can never read as exhaustive.
 */
export interface SavedExtrasCoverage {
  cap: number;
  included: number;
  omitted: number;
}

/**
 * Assemble the set of statements consolidation will reason about.
 *
 * Pure, so it unit-tests without a database. For each of the top `limit`
 * window entries: an explainable entry joins as itself; a normalised entry
 * joins through a matching saved query, which supplies representative
 * parameters while the entry supplies the measured weight (the §6.1 answer);
 * anything else is skipped with its reason — parameters are never guessed.
 * With `includeSaved`, unmatched saved queries join carrying no window weight —
 * but capped at `limit`, the same bound the window path already obeys, so a
 * large saved set cannot grow the proof matrix past what the request validated.
 */
export function buildScope(
  ranked: RankedEntry[],
  saved: SavedQuery[],
  opts: { limit: number; includeSaved: boolean },
): { members: ScopeMember[]; skipped: SkippedEntry[]; savedExtras: SavedExtrasCoverage } {
  const members = new Map<string, ScopeMember>();
  const skipped: SkippedEntry[] = [];

  const savedByKey = new Map<string, SavedQuery>();
  for (const s of saved) {
    const key = matchKey(s.sql);
    if (!savedByKey.has(key)) savedByKey.set(key, s);
  }
  const matchedNames = new Set<string>();

  // Scope is deduped by fingerprint of the planned text; shares sum, so two
  // window entries standing in through one saved query pool their weight.
  const add = (member: ScopeMember): void => {
    const existing = members.get(member.fingerprint);
    if (existing) {
      existing.share += member.share;
      return;
    }
    members.set(member.fingerprint, member);
  };

  const refusalFor = (sql: string): string => {
    const admission = admitQuery(sql);
    if (!admission.ok) return admission.reason ?? 'The statement was refused by admission.';
    return isExplainable(sql).reason ?? 'The statement cannot be planned as-is.';
  };

  for (const entry of ranked.slice(0, opts.limit)) {
    if (admitQuery(entry.query).ok && isExplainable(entry.query).ok) {
      add({
        source: 'workload',
        sql: entry.query,
        share: entry.share,
        queryId: entry.queryId,
        savedName: null,
        fingerprint: fingerprint(entry.query),
      });
      continue;
    }

    const standIn = savedByKey.get(matchKey(entry.query));
    if (standIn && admitQuery(standIn.sql).ok && isExplainable(standIn.sql).ok) {
      matchedNames.add(standIn.name);
      add({
        source: 'saved-matched',
        sql: standIn.sql,
        share: entry.share,
        queryId: entry.queryId,
        savedName: standIn.name,
        fingerprint: fingerprint(standIn.sql),
      });
      continue;
    }

    skipped.push({
      queryId: entry.queryId,
      savedName: null,
      share: entry.share,
      reason: refusalFor(entry.query),
      hint: 'Save a runnable variant with representative literals — a matching saved query stands in for the normalised text.',
    });
  }

  // Saved extras are capped by `limit`, the same bound the window obeys. The
  // cap gates only the members that would cost EXPLAINs (the ones actually
  // added): inadmissible and already-in-scope saved queries are filtered first
  // and cost nothing, so they are not charged against the cap.
  let savedIncluded = 0;
  let savedOmitted = 0;
  if (opts.includeSaved) {
    for (const s of saved) {
      if (matchedNames.has(s.name)) continue;
      if (!admitQuery(s.sql).ok || !isExplainable(s.sql).ok) {
        skipped.push({
          queryId: null,
          savedName: s.name,
          share: 0,
          reason: refusalFor(s.sql),
          hint: null,
        });
        continue;
      }
      const fp = fingerprint(s.sql);
      // Already in scope through the window — the saved copy adds nothing.
      if (members.has(fp)) continue;
      if (savedIncluded >= opts.limit) {
        savedOmitted += 1;
        continue;
      }
      add({
        source: 'saved-extra',
        sql: s.sql,
        share: 0,
        queryId: null,
        savedName: s.name,
        fingerprint: fp,
      });
      savedIncluded += 1;
    }
  }

  // One aggregate skip when the cap bit — bounded regardless of how many saved
  // queries exist, so a 10k-row saved set discloses the truncation in a single
  // line rather than flooding the report.
  if (savedOmitted > 0) {
    skipped.push({
      queryId: null,
      savedName: null,
      share: 0,
      reason:
        `${savedOmitted} more saved quer${savedOmitted === 1 ? 'y was' : 'ies were'} not proved: the ` +
        `saved-query contribution is capped at ${opts.limit} (the request's \`limit\`), so a large saved ` +
        'set cannot drive an unbounded proof.',
      hint: 'Raise "limit" (max 25) or prune the saved set to include more.',
    });
  }

  return {
    members: [...members.values()],
    skipped,
    savedExtras: { cap: opts.limit, included: savedIncluded, omitted: savedOmitted },
  };
}

export interface ConsolidationPerQuery {
  fingerprint: string;
  queryId: string | null;
  savedName: string | null;
  source: ScopeMember['source'];
  share: number;
  /** True when the candidate structurally claims to serve this statement. */
  claimed: boolean;
  verdict: string | null;
  costBefore: number | null;
  costAfter: number | null;
  costChange: number | null;
  headline: string | null;
  accessChanges: string[];
  error: string | null;
}

export interface ConsolidationCandidateReport extends ConsolidatedIndex {
  perQuery: ConsolidationPerQuery[];
  /** Claimed statements the planner actually preferred the index for. */
  served: number;
  /** Sum of the served statements' window shares. */
  servedShare: number;
  /** Statements (claimed or sentinel) the planner said get worse. */
  regressed: number;
  verdict: 'improved' | 'regressed' | 'unchanged';
  summary: string;
  costOnly: true;
  note: string;
  decisionId: number | null;
}

export interface ConsolidationScopeQuery {
  fingerprint: string;
  sql: string;
  share: number;
  source: ScopeMember['source'];
  queryId: string | null;
  savedName: string | null;
  /** No index demand — the statement stays as a regression sentinel. */
  noDemand: boolean;
}

export interface ConsolidationReport {
  window: {
    isDelta: boolean;
    fromAt: string | null;
    toAt: string;
    totalMs: number;
    resetDetected: boolean;
  };
  scope: {
    queries: ConsolidationScopeQuery[];
    skipped: SkippedEntry[];
    /** Share of window time the in-scope statements account for. */
    explainableShare: number;
    /** How the request's `limit` bounded the saved-query contribution. */
    savedExtras: SavedExtrasCoverage;
  };
  candidates: ConsolidationCandidateReport[];
  standalone: Array<{ relation: string; columns: string[]; fingerprints: string[] }>;
  omitted: Array<{ relation: string; columns: string[]; weight: number }>;
  summary: string;
}

/** The label a human recognises a scope row by, shortest honest form first. */
function labelFor(row: { savedName: string | null; queryId: string | null; fingerprint: string }): string {
  if (row.savedName) return `\`${row.savedName}\``;
  if (row.queryId) return `query ${row.queryId}`;
  return `\`${row.fingerprint.slice(0, 60)}\``;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function candidateSummary(
  candidate: ConsolidatedIndex,
  perQuery: ConsolidationPerQuery[],
  verdict: 'improved' | 'regressed' | 'unchanged',
  served: number,
  servedShare: number,
  regressed: number,
): string {
  const tested = perQuery.length;
  // The heuristic claimed service and the planner said no. Reporting that is
  // the product's whole argument: being wrong is detected, not shipped.
  const declined = perQuery.filter(
    (r) => r.claimed && r.verdict !== null && r.verdict !== 'improved' && r.verdict !== 'regressed',
  );
  const declinedNote = declined
    .slice(0, 3)
    .map((r) => ` Claimed to serve ${labelFor(r)} but the planner declined — not counted.`)
    .join('');

  if (verdict === 'regressed') {
    return (
      `Regresses ${plural(regressed, 'statement')} of the ${tested} it was tested against — do not apply.` +
      declinedNote
    );
  }
  if (verdict === 'unchanged') {
    return (
      'The planner declined this index for every statement it was tested against — the merged shape ' +
      'was structurally sound but wins nothing on this database.' +
      declinedNote
    );
  }
  const shareClause =
    servedShare > 0
      ? `${formatPercent(servedShare)} of all query time in this window`
      : 'all outside the measured window, so no window share to weight them by';
  const replaceClause =
    candidate.replaces.length > 0
      ? `, and would replace ${plural(candidate.replaces.length, 'narrower single-query index')}`
      : '';
  return (
    `Serves ${served} of the ${tested} explainable statements it was tested against — ${shareClause} — ` +
    `regresses none of the ${tested}${replaceClause}.` +
    declinedNote
  );
}

/**
 * The window, the scope, the merge, and the proof matrix — one call.
 *
 * Refusals come first and cost nothing: no hypopg, no pg_stat_statements, or
 * no snapshots each 412 before a single EXPLAIN is spent. Per-query failures
 * after that demote the query to skipped (extraction) or to an error row
 * (proof), never failing the whole request.
 */
export async function consolidateWorkload(
  db: Database,
  store: Store,
  opts: { includeSaved: boolean; limit: number; maxCandidates: number },
): Promise<ConsolidationReport> {
  const probe = await db.probe();
  if (!probe.connected) {
    throw new AgentError(probe.error ?? 'Not connected to the database.', null, 400);
  }
  if (!probe.hypopgInstalled) {
    // The exact refusal whatIfIndex raises, surfaced before any EXPLAIN is
    // spent — a proof endpoint that cannot prove should say so immediately.
    throw new AgentError(
      'The hypopg extension is not installed on this database.',
      'Run CREATE EXTENSION hypopg. On managed providers it may not be offered at all — in that case use a shadow database, ' +
        'where the agent controls what is installed.',
      412,
    );
  }

  const availability = await probeWorkload(db);
  if (!availability.installed) {
    throw new AgentError(availability.reason ?? 'pg_stat_statements unavailable.', availability.hint, 412);
  }

  const snapshots = store.recentWorkloadSnapshots(2);
  const current = snapshots[0];
  if (!current) {
    throw new AgentError(
      'No workload snapshots yet — nothing to weight candidates by.',
      'Open the Workload page or POST /api/workload/snapshot, let some traffic run, then snapshot again.',
      412,
    );
  }

  // The same window computation GET /api/workload serves — but never an
  // auto-snapshot: that is the Workload page's first-visit convenience, not a
  // side effect a proof endpoint should have.
  const previous = snapshots[1];
  const { entries, resetDetected } = deltaWorkload(
    (previous?.entries as WorkloadEntry[] | undefined) ?? null,
    current.entries as WorkloadEntry[],
  );
  const { ranked, totalMs } = rankWorkload(entries);

  // includeSaved gates saved queries entirely — stand-ins and extras both —
  // matching the UI checkbox's plain reading.
  const saved = opts.includeSaved ? store.listSavedQueries() : [];
  const { members, skipped, savedExtras } = buildScope(ranked, saved, {
    limit: opts.limit,
    includeSaved: opts.includeSaved,
  });

  // Demand extraction: one plain EXPLAIN per scope member. A failure demotes
  // the member to skipped with the reason — a dropped table or a timeout must
  // cost that one statement, not the report.
  const scopeQueries: ConsolidationScopeQuery[] = [];
  const planned: ScopeMember[] = [];
  const weighted: WeightedDemand[] = [];
  for (const member of members) {
    try {
      const plan = await runExplain(db, member.sql, {});
      const demands = extractIndexDemands(plan);
      for (const d of demands) {
        weighted.push({
          relation: d.relation,
          equality: d.equality,
          range: d.range,
          queries: [{ fingerprint: member.fingerprint, weight: member.share }],
        });
      }
      planned.push(member);
      scopeQueries.push({
        fingerprint: member.fingerprint,
        sql: member.sql,
        share: member.share,
        source: member.source,
        queryId: member.queryId,
        savedName: member.savedName,
        noDemand: demands.length === 0,
      });
    } catch (err) {
      const message = err instanceof AgentError ? err.message : describeDbError(err).message;
      skipped.push({
        queryId: member.queryId,
        savedName: member.savedName,
        share: member.share,
        reason: `EXPLAIN failed: ${message}`,
        hint: null,
      });
    }
  }

  const mergeResult = consolidateDemands(weighted, {
    maxCandidates: opts.maxCandidates,
    maxColumns: 5,
  });

  // The proof matrix: every candidate against EVERY planned statement.
  // Sentinels included — "regresses none" is only claimable because the
  // non-claimed statements were re-planned too.
  const candidates: ConsolidationCandidateReport[] = [];
  for (const candidate of mergeResult.candidates) {
    // CONCURRENTLY is for the real index someone runs later; HypoPG rejects it.
    const testDdl = candidate.ddl.replace(/\s+CONCURRENTLY\b/i, '');
    const perQuery: ConsolidationPerQuery[] = [];
    for (const member of planned) {
      const claimed = candidate.claims.includes(member.fingerprint);
      const base = {
        fingerprint: member.fingerprint,
        queryId: member.queryId,
        savedName: member.savedName,
        source: member.source,
        share: member.share,
        claimed,
      };
      try {
        // Only the diff summary survives: C×Q full plans would be megabytes.
        const proof = await whatIfIndex(db, member.sql, testDdl);
        const s = proof.diff.summary;
        perQuery.push({
          ...base,
          verdict: s.verdict,
          costBefore: s.costBefore,
          costAfter: s.costAfter,
          costChange: s.costChange,
          headline: s.headline,
          accessChanges: s.accessChanges,
          error: null,
        });
      } catch (err) {
        perQuery.push({
          ...base,
          verdict: null,
          costBefore: null,
          costAfter: null,
          costChange: null,
          headline: null,
          accessChanges: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const servedRows = perQuery.filter((r) => r.claimed && r.verdict === 'improved');
    const regressedRows = perQuery.filter((r) => r.verdict === 'regressed');
    // ANY regression — claimed or sentinel — overrides served counts, exactly
    // as the OR-split rewrite reports an honest loss.
    const verdict: ConsolidationCandidateReport['verdict'] =
      regressedRows.length > 0 ? 'regressed' : servedRows.length > 0 ? 'improved' : 'unchanged';
    const servedShare = servedRows.reduce((sum, r) => sum + r.share, 0);
    const summary = candidateSummary(
      candidate,
      perQuery,
      verdict,
      servedRows.length,
      servedShare,
      regressedRows.length,
    );

    // Record the decision server-side, attributed to the highest-share claimed
    // statement (decisions.fingerprint is NOT NULL and per-query history is
    // where decisions surface). A storage failure must not cost the result.
    let decisionId: number | null = null;
    const attribution = perQuery
      .filter((r) => r.claimed)
      .sort((a, b) => b.share - a.share)[0];
    if (attribution) {
      try {
        decisionId = store.recordDecision({
          analysisSlug: null,
          fingerprint: attribution.fingerprint,
          kind: 'index',
          change: candidate.ddl,
          verdict,
          headline: summary,
          costBefore: attribution.costBefore,
          costAfter: attribution.costAfter,
          costOnly: true,
        }).id;
      } catch (err) {
        console.warn(
          '[agent] could not record consolidation decision:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    candidates.push({
      ...candidate,
      perQuery,
      served: servedRows.length,
      servedShare,
      regressed: regressedRows.length,
      verdict,
      summary,
      costOnly: true,
      note:
        'Hypothetical indexes cannot be executed against, so this compares planner cost estimates rather than measured time. ' +
        'A plan-shape change here is strong evidence the index would be used; the size of the speedup is not proven until you build it. ' +
        'Each candidate was proven alone; indexes interact, so after building one, re-run before building the next.',
      decisionId,
    });
  }

  const explainableShare = scopeQueries.reduce((sum, q) => sum + q.share, 0);
  const windowConsidered = Math.min(ranked.length, opts.limit);
  const skippedWindow = skipped.filter((s) => s.queryId !== null).length;
  const skippedNote =
    skippedWindow > 0
      ? `${skippedWindow} of the ${windowConsidered} window entries considered were skipped as unexplainable — ` +
        'save a runnable variant with representative literals to include them.'
      : windowConsidered > 0
        ? 'Every window entry considered was explainable.'
        : 'The window contains no entries.';

  const summary =
    candidates.length > 0
      ? `Proved ${plural(candidates.length, 'consolidated index candidate')} against ${plural(
          scopeQueries.length,
          'statement',
        )} covering ${formatPercent(explainableShare)} of window time. ${skippedNote}`
      : `Nothing to consolidate. ${skippedNote}${
          mergeResult.standalone.length > 0
            ? ` ${plural(mergeResult.standalone.length, 'single-query demand')} belong${
                mergeResult.standalone.length === 1 ? 's' : ''
              } to the per-query advisor — see standalone.`
            : ' The explainable statements yielded no shared index demand.'
        }`;

  return {
    window: {
      isDelta: Boolean(previous),
      fromAt: previous?.takenAt ?? null,
      toAt: current.takenAt,
      totalMs,
      resetDetected,
    },
    scope: { queries: scopeQueries, skipped, explainableShare, savedExtras },
    candidates,
    standalone: mergeResult.standalone,
    omitted: mergeResult.omitted,
    summary,
  };
}
