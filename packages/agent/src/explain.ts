/**
 * Running EXPLAIN, and producing the full analysis from it.
 *
 * Analysis happens here, agent-side, rather than in the hosted service. That is
 * the architecture decision from REQUIREMENTS.md §6.2 made concrete: the agent
 * is not a metrics shipper, it is where `plan(sql, world)` runs. Raw query text
 * — which is where the PII lives — never has to leave the customer's network.
 */

import {
  analyze,
  diffPlans,
  layoutFlame,
  narratePlan,
  parseExplainJson,
  suggestIndexes,
  type Finding,
  type FlameLayout,
  type IndexSuggestion,
  type PlanDiff,
  type QueryPlan,
} from '@query-not/core';

import { parseSync } from 'libpg-query';

import type { Database } from './db.ts';
import { admitGucs, admitIndexDdl, admitQuery, fingerprint } from './safety.ts';
import { analyzeRewrites, type RewriteFinding } from './rewrite.ts';
import {
  buildCatalogProbe,
  buildVolatilityProbe,
  interpretChecks,
  type CatalogRow,
  type PreconditionCheck,
} from './catalog.ts';
import {
  buildComparisonSql,
  equivalenceGuard,
  harvestFunctionNames,
  interpretComparison,
  type ComparisonRow,
  type EquivalenceResult,
} from './equivalence.ts';
import type { CandidateRewrite, GeneratedRewriteKind } from './transform.ts';

export class AgentError extends Error {
  readonly hint: string | null;
  readonly status: number;

  constructor(message: string, hint: string | null = null, status = 400) {
    super(message);
    this.name = 'AgentError';
    this.hint = hint;
    this.status = status;
  }
}

export interface ExplainOptions {
  /** Execute the query to collect real measurements. Off by default — it runs the query. */
  analyze?: boolean;
  gucs?: Record<string, string>;
  allowWrites?: boolean;
}

/** The full result for one query: plan, diagnosis, advice, narration, layout. */
export interface Analysis {
  plan: QueryPlan;
  findings: Finding[];
  indexSuggestions: IndexSuggestion[];
  /** Structural anti-patterns found in the SQL text itself, via the AST. */
  rewrites: RewriteFinding[];
  narration: string;
  flame: FlameLayout;
  fingerprint: string;
}

function buildExplainOptions(opts: ExplainOptions, includeSettings: boolean): string {
  const parts = ['FORMAT JSON'];
  if (opts.analyze) parts.push('ANALYZE', 'BUFFERS');
  if (includeSettings) parts.push('SETTINGS');
  return parts.join(', ');
}

/** Run EXPLAIN and return the parsed IR. */
export async function runExplain(
  db: Database,
  sql: string,
  opts: ExplainOptions = {},
): Promise<QueryPlan> {
  const admission = admitQuery(sql, { allowWrites: opts.allowWrites ?? false });
  if (!admission.ok) throw new AgentError(admission.reason ?? 'Query refused.');

  if (opts.gucs) {
    const gucCheck = admitGucs(opts.gucs);
    if (!gucCheck.ok) throw new AgentError(gucCheck.reason ?? 'Invalid settings.');
  }

  const statement = sql.trim().replace(/;\s*$/, '');

  return db.readOnlySession(
    async (client) => {
      const attempt = async (includeSettings: boolean) => {
        const options = buildExplainOptions(opts, includeSettings);
        const result = await client.query<Record<string, unknown>>(
          `EXPLAIN (${options}) ${statement}`,
        );
        // Postgres returns the JSON document in a single column of a single row.
        const row = result.rows[0];
        if (!row) throw new AgentError('EXPLAIN returned no rows.', null, 500);
        const payload = Object.values(row)[0];
        return parseExplainJson(payload as unknown, statement);
      };

      try {
        return await attempt(true);
      } catch (err) {
        // SETTINGS needs PG 12+. Retry without it rather than failing outright.
        const code = (err as { code?: string }).code;
        if (code === '42601') return attempt(false);
        throw err;
      }
    },
    { gucs: opts.gucs ?? {}, allowWrites: opts.allowWrites ?? false },
  );
}

/** Explain a query and run the full analysis over the result. */
export async function analyzeQuery(
  db: Database,
  sql: string,
  opts: ExplainOptions = {},
): Promise<Analysis> {
  const plan = await runExplain(db, sql, opts);

  // The rewrite advisor is independent of the plan — it reads the SQL. If its
  // parser disagrees with the server (it is pinned to one Postgres major and
  // the target may be another), that is not a reason to fail an analysis that
  // otherwise succeeded.
  let rewrites: RewriteFinding[] = [];
  try {
    rewrites = analyzeRewrites(sql);
  } catch (err) {
    console.warn('[agent] rewrite analysis skipped:', err instanceof Error ? err.message : err);
  }

  return {
    plan,
    findings: analyze(plan),
    indexSuggestions: suggestIndexes(plan),
    rewrites,
    narration: narratePlan(plan),
    flame: layoutFlame(plan),
    fingerprint: fingerprint(sql),
  };
}

export interface WhatIfResult {
  before: QueryPlan;
  after: QueryPlan;
  diff: PlanDiff;
  /** What was changed to produce `after`. */
  change:
    | { kind: 'index'; ddl: string }
    | { kind: 'settings'; settings: Record<string, string> }
    | { kind: 'rewrite'; sql: string };
  /** Findings on the after-plan, so you can see what the change did and did not fix. */
  findingsAfter: Finding[];
  /**
   * Set when the comparison is planner-cost only. Hypothetical indexes cannot
   * be measured — there is nothing to execute against — so the UI must present
   * the result as the planner's opinion, not an observed speedup.
   */
  costOnly: boolean;
  note: string | null;
}

/**
 * HypoPG names its indexes `<13605>btree_orders_status_created_at` — the oid
 * prefix is an internal detail that otherwise leaks into headlines and diffs.
 * Rewrite it into something that reads as what it is.
 *
 * Postgres-specific, so it lives here rather than in the engine-neutral core.
 */
function relabelHypotheticalIndexes(plan: QueryPlan): QueryPlan {
  for (const node of plan.nodes) {
    if (node.indexName && /^<\d+>/.test(node.indexName)) {
      node.indexName = `hypothetical ${node.indexName.replace(/^<\d+>/, '')}`;
    }
  }
  return plan;
}

/**
 * Test an index without building it.
 *
 * HypoPG registers the index in backend memory, so the planner costs it as if
 * it existed while nothing is written to disk. The catch, and it is a real one:
 * this works with plain EXPLAIN only. A hypothetical index cannot be scanned,
 * so ANALYZE has nothing to execute. The result is plan-shape proof, not timing
 * proof, and `costOnly` is how that reaches the UI.
 */
export async function whatIfIndex(
  db: Database,
  sql: string,
  ddl: string,
): Promise<WhatIfResult> {
  const admission = admitQuery(sql);
  if (!admission.ok) throw new AgentError(admission.reason ?? 'Query refused.');

  const ddlCheck = admitIndexDdl(ddl);
  if (!ddlCheck.ok) throw new AgentError(ddlCheck.reason ?? 'Invalid index DDL.');

  const statement = sql.trim().replace(/;\s*$/, '');

  const { before, after } = await db.readOnlySession(async (client) => {
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

    try {
      const explain = async () => {
        const res = await client.query<Record<string, unknown>>(
          `EXPLAIN (FORMAT JSON) ${statement}`,
        );
        const row = res.rows[0];
        if (!row) throw new AgentError('EXPLAIN returned no rows.', null, 500);
        return parseExplainJson(Object.values(row)[0] as unknown, statement);
      };

      const beforePlan = await explain();

      // The DDL is passed as a bind parameter, so it is never concatenated into
      // a statement — hypopg_create_index takes the definition as text.
      await client.query('SELECT indexname FROM hypopg_create_index($1)', [
        ddl.trim().replace(/;\s*$/, ''),
      ]);

      const afterPlan = await explain();
      return { before: beforePlan, after: relabelHypotheticalIndexes(afterPlan) };
    } finally {
      // Hypothetical indexes live in backend memory for the whole session, not
      // the transaction — ROLLBACK does not clear them. Without this reset the
      // connection returns to the pool still carrying them, and would silently
      // poison every later query on it.
      await client.query('SELECT hypopg_reset()').catch(() => undefined);
    }
  });

  const diff = diffPlans(before, after);

  return {
    before,
    after,
    diff,
    change: { kind: 'index', ddl },
    findingsAfter: analyze(after),
    costOnly: true,
    note:
      'Hypothetical indexes cannot be executed against, so this compares planner cost estimates rather than measured time. ' +
      'A plan-shape change here is strong evidence the index would be used; the size of the speedup is not proven until you build it.',
  };
}

/**
 * Re-plan under different settings.
 *
 * Unlike the index case this can be measured, because the query is real and so
 * are the settings — so `analyze` is honoured and the comparison is wall-clock.
 */
export async function whatIfSettings(
  db: Database,
  sql: string,
  settings: Record<string, string>,
  opts: { analyze?: boolean } = {},
): Promise<WhatIfResult> {
  const gucCheck = admitGucs(settings);
  if (!gucCheck.ok) throw new AgentError(gucCheck.reason ?? 'Invalid settings.');

  const before = await runExplain(db, sql, { analyze: opts.analyze ?? false });
  const after = await runExplain(db, sql, { analyze: opts.analyze ?? false, gucs: settings });
  const diff = diffPlans(before, after);

  return {
    before,
    after,
    diff,
    change: { kind: 'settings', settings },
    findingsAfter: analyze(after),
    costOnly: !(opts.analyze ?? false),
    note: opts.analyze
      ? 'Both plans were executed, so this comparison is measured wall-clock time. Run it more than once — a first run pays cold-cache costs the second does not.'
      : 'Neither plan was executed, so this compares planner cost estimates. Enable ANALYZE to measure it.',
  };
}

export type RewriteProofOutcome =
  | 'proven'
  | 'improved-unverified'
  | 'no-effect'
  | 'regressed'
  | 'differed'
  | 'advice-only';

export interface RewriteProof {
  candidate: CandidateRewrite;
  preconditions: PreconditionCheck[];
  outcome: RewriteProofOutcome;
  /** Null when preconditions failed — nothing was executed. */
  planDiff: WhatIfResult | null;
  /** Null when preconditions failed. `not-checkable` when the guard refused. */
  equivalence: EquivalenceResult | null;
  /** The composed verdict sentence, citing its evidence. */
  note: string;
}

const sentence = (s: string): string =>
  s.length > 0 ? `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : s;

/**
 * Prove a generated rewrite, or refuse with the reason.
 *
 * The client sends only the finding's coordinates. The candidate is re-derived
 * here from the submitted SQL, so a proof can only ever describe this agent's
 * own transform — never text something else edited.
 *
 * The checks run in one read-only session, in a fixed order, and each layer
 * stops the next: preconditions that fail mean nothing executes at all;
 * a guard-refused equivalence downgrades `proven` to `improved-unverified`;
 * a row mismatch overrides everything and says do not apply. `proven` means
 * the preconditions held as schema facts, the planner preferred the rewrite,
 * and both forms returned identical rows on the current data — with the note
 * citing all three, because a claim without its evidence is just a vibe.
 */
export async function whatIfRewrite(
  db: Database,
  sql: string,
  kind: GeneratedRewriteKind,
  location: number | null,
  opts: { analyze?: boolean } = {},
): Promise<RewriteProof> {
  const admission = admitQuery(sql);
  if (!admission.ok) throw new AgentError(admission.reason ?? 'Query refused.');

  const finding = analyzeRewrites(sql).find((f) => f.kind === kind && f.location === location);
  if (!finding) {
    throw new AgentError('The SQL no longer produces this finding — re-run the analysis.', null, 409);
  }
  if (!finding.candidate) {
    throw new AgentError(
      finding.candidateBlocked ?? 'No generated rewrite exists for this finding.',
      null,
      409,
    );
  }
  const candidate = finding.candidate;

  // Generated output is untrusted by design. If it cannot pass the same gate
  // as user input, nothing runs — and that is a bug worth a 500, not a quiet
  // downgrade.
  const rewrittenAdmission = admitQuery(candidate.sql);
  if (!rewrittenAdmission.ok) {
    throw new AgentError(
      `The generated rewrite failed admission: ${rewrittenAdmission.reason}`,
      null,
      500,
    );
  }

  const statement = sql.trim().replace(/;\s*$/, '');
  const rewritten = candidate.sql.trim().replace(/;\s*$/, '');
  const measured = opts.analyze ?? false;

  return db.readOnlySession(async (client) => {
    // Preconditions first, in the session whose search_path the query itself
    // gets. Failing any of them means the rewrite is not safe to run even for
    // comparison — the original's semantics are the only ones we know we have.
    const probe = buildCatalogProbe(candidate.preconditions);
    const probeRows: CatalogRow[] = candidate.preconditions.length > 0
      ? (await client.query<CatalogRow>(probe.text, probe.values)).rows
      : [];
    const tz =
      (await client.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)).rows[0]?.tz ?? 'UTC';
    const preconditions = interpretChecks(candidate.preconditions, probeRows, { timeZone: tz });

    const failed = preconditions.filter((p) => !p.established);
    if (failed.length > 0) {
      return {
        candidate,
        preconditions,
        outcome: 'advice-only' as const,
        planDiff: null,
        equivalence: null,
        note: `Not executed: ${failed.map((f) => f.evidence).join('; ')}. The written advice and its caveat stand.`,
      };
    }

    const explain = async (text: string): Promise<QueryPlan> => {
      const res = await client.query<Record<string, unknown>>(
        `EXPLAIN (${measured ? 'ANALYZE, BUFFERS, ' : ''}FORMAT JSON) ${text}`,
      );
      const row = res.rows[0];
      if (!row) throw new AgentError('EXPLAIN returned no rows.', null, 500);
      return parseExplainJson(Object.values(row)[0] as unknown, text);
    };

    const before = await explain(statement);
    const after = await explain(rewritten);
    const diff = diffPlans(before, after);
    const planDiff: WhatIfResult = {
      before,
      after,
      diff,
      change: { kind: 'rewrite', sql: candidate.sql },
      findingsAfter: analyze(after),
      costOnly: !measured,
      note: measured
        ? 'Both forms were executed, so this comparison is measured wall-clock time. Run it more than once — a first run pays cold-cache costs the second does not.'
        : 'Neither form was executed for the plan comparison, so it reflects planner cost estimates. Enable ANALYZE to measure it.',
    };

    // Row-level equivalence, where a row-level claim is sound at all.
    const tree = parseSync(statement);
    const names = harvestFunctionNames(tree);
    let volatile = new Set<string>();
    if (names.length > 0) {
      const vp = buildVolatilityProbe(names);
      const vrows = await client.query<{ proname: string }>(vp.text, vp.values);
      volatile = new Set(vrows.rows.map((r) => r.proname));
    }

    const guard = equivalenceGuard(tree, volatile);
    let equivalence: EquivalenceResult;
    if (!guard.checkable) {
      equivalence = {
        status: 'not-checkable',
        rowsOriginal: null,
        rowsRewritten: null,
        onlyInOriginal: null,
        onlyInRewritten: null,
        comparedAs: null,
        note: guard.reason,
      };
    } else {
      // Parallel workers reorder floating-point aggregation, which is the one
      // known source of false mismatch we can simply remove. SET LOCAL dies
      // with the transaction.
      await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
      const cmp = buildComparisonSql(statement, rewritten);
      try {
        const row = (await client.query<ComparisonRow>(cmp.text)).rows[0]!;
        equivalence = interpretComparison(row, cmp.cap, 'native');
      } catch (err) {
        if ((err as { code?: string }).code === '42883') {
          // The row type has no equality operator (json, xml, point); compare
          // the rows' text form and say so.
          const textCmp = buildComparisonSql(statement, rewritten, { asText: true });
          const row = (await client.query<ComparisonRow>(textCmp.text)).rows[0]!;
          equivalence = interpretComparison(row, textCmp.cap, 'text');
        } else {
          throw err;
        }
      }
    }

    const established = preconditions.map((p) => p.evidence).join('; ');
    const verdict = diff.summary.verdict;
    let outcome: RewriteProofOutcome;
    let note: string;
    if (equivalence.status === 'mismatch') {
      outcome = 'differed';
      note = sentence(equivalence.note);
    } else if (verdict === 'improved') {
      if (equivalence.status === 'match') {
        outcome = 'proven';
        // The structural fact leads the sentence: an on-data match can be
        // coincidence, the schema fact is why it cannot be, here.
        note = `${diff.summary.headline} Safe because ${established}. ${sentence(equivalence.note)}`;
      } else {
        outcome = 'improved-unverified';
        note = `${diff.summary.headline} Row-level verification did not run: ${sentence(equivalence.note)}`;
      }
    } else if (verdict === 'regressed') {
      outcome = 'regressed';
      note = `${diff.summary.headline} The planner prefers the original on this database — do not apply.`;
    } else {
      outcome = 'no-effect';
      note = `${diff.summary.headline}${equivalence.status === 'match' ? ` ${sentence(equivalence.note)}` : ''}`;
    }

    return { candidate, preconditions, outcome, planDiff, equivalence, note };
  });
}

/**
 * Test every suggested index in turn and keep the ones that actually change the
 * plan.
 *
 * This is the point of the whole design. Index suggestions are extracted from
 * predicate text by heuristic, and a heuristic is allowed to be wrong — as long
 * as being wrong is *detected* rather than shipped. A suggestion that does not
 * move the plan is filtered out here, before anyone sees it.
 */
export async function verifySuggestions(
  db: Database,
  sql: string,
  suggestions: IndexSuggestion[],
): Promise<Array<{ suggestion: IndexSuggestion; result: WhatIfResult | null; error: string | null }>> {
  const out: Array<{ suggestion: IndexSuggestion; result: WhatIfResult | null; error: string | null }> = [];

  for (const suggestion of suggestions) {
    // CONCURRENTLY is for the real index someone runs later; HypoPG rejects it.
    const testDdl = suggestion.ddl.replace(/\s+CONCURRENTLY\b/i, '');
    try {
      out.push({ suggestion, result: await whatIfIndex(db, sql, testDdl), error: null });
    } catch (err) {
      out.push({
        suggestion,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}
