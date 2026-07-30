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

import type { Database } from './db.ts';
import { admitGucs, admitIndexDdl, admitQuery, fingerprint } from './safety.ts';

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
  return {
    plan,
    findings: analyze(plan),
    indexSuggestions: suggestIndexes(plan),
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
  change: { kind: 'index'; ddl: string } | { kind: 'settings'; settings: Record<string, string> };
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
