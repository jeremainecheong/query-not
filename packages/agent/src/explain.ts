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
  describeNode,
  diffPlans,
  layoutFlame,
  narratePlan,
  parseExplainJson,
  suggestExtendedStatistics,
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
  buildAggregateProbe,
  buildCatalogProbe,
  buildUniqueIndexProbe,
  buildVolatilityProbe,
  interpretAggregateChecks,
  interpretChecks,
  interpretIsAggregateChecks,
  interpretUniqueChecks,
  type AggregatePrecondition,
  type CatalogRow,
  type ColumnPrecondition,
  type IsAggregatePrecondition,
  type PreconditionCheck,
  type UniqueIndexRow,
  type UniqueKeyPrecondition,
} from './catalog.ts';
import {
  buildComparisonSql,
  equivalenceGuard,
  harvestFunctionNames,
  interpretComparison,
  type ComparisonRow,
  type EquivalenceResult,
} from './equivalence.ts';
import {
  buildAdviceDdl,
  buildDependencyEvidenceSql,
  buildProofDdl,
  buildStatisticsProbe,
  classifyOutcome,
  composeStatisticsNote,
  confirmConjunctionFromAst,
  interpretStatisticsProbe,
  parseDependencies,
  pickTargetNode,
  statisticsProbeUnavailable,
  validateStatisticsColumns,
  type DependencyPair,
  type StatisticsAccuracySide,
  type StatisticsFinding,
  type StatisticsProbeCandidate,
  type StatisticsProbeRow,
  type StatisticsProof,
} from './statistics.ts';
import type { CandidateRewrite, GeneratedRewriteKind } from './transform.ts';
import { SqlParseError } from './rewrite.ts';
import {
  accessSignature,
  buildStatsProbe,
  buildVariants,
  chooseSite,
  composeNarrative,
  discoverPredicates,
  findFlips,
  hasParamRef,
  interpretStats,
  SENSITIVITY_NOTE,
  type FlipPoint,
  type PredicateSite,
  type SensitivityResult,
  type SensitivityVariant,
  type StatsRow,
  type VariantSpec,
} from './sensitivity.ts';

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
  /** CREATE STATISTICS advice for correlated-column misestimates. */
  statisticsSuggestions: StatisticsFinding[];
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

  // Same degradation posture for statistics advice: a probe or parse failure
  // costs that one feature, never the analysis.
  let statisticsSuggestions: StatisticsFinding[] = [];
  try {
    statisticsSuggestions = await deriveStatisticsSuggestions(db, sql, plan);
  } catch (err) {
    console.warn('[agent] statistics advice skipped:', err instanceof Error ? err.message : err);
  }

  return {
    plan,
    findings: analyze(plan),
    indexSuggestions: suggestIndexes(plan),
    statisticsSuggestions,
    rewrites,
    narration: narratePlan(plan),
    flame: layoutFlame(plan),
    fingerprint: fingerprint(sql),
  };
}

/**
 * Refine core's extended-statistics candidates into findings.
 *
 * Layer 2 of the detection: core read columns out of deparsed plan text; here
 * each candidate is re-checked against the SQL's AST — agreement upgrades the
 * source to 'ast', an unresolvable scope (view, CTE, parser unavailable)
 * downgrades confidence with a caveat naming the degradation, and a positive
 * contradiction drops the candidate: refuse rather than guess. Then one
 * catalog probe (fresh session, never cached) reports whether a covering
 * statistics object already exists and in what state.
 */
async function deriveStatisticsSuggestions(
  db: Database,
  sql: string,
  plan: QueryPlan,
): Promise<StatisticsFinding[]> {
  const candidates = suggestExtendedStatistics(plan);
  if (candidates.length === 0) return [];

  const refined: StatisticsFinding[] = [];
  for (const candidate of candidates) {
    const alias = plan.nodes.find((n) => n.id === candidate.nodeId)?.alias ?? null;
    let source: StatisticsFinding['source'] = 'plan-text';
    let confidence = candidate.confidence;
    let caveat = candidate.caveat;
    try {
      const check = confirmConjunctionFromAst(sql, candidate.relation, alias, candidate.columns);
      if (check.verdict === 'contradicted') {
        console.warn(`[agent] statistics candidate dropped: ${check.reason}`);
        continue;
      }
      if (check.verdict === 'confirmed') {
        source = 'ast';
        confidence = 'high';
      }
    } catch {
      // Parser unavailable or the SQL did not parse — fall through to plan-text.
    }
    if (source === 'plan-text') {
      confidence = confidence === 'high' ? 'medium' : confidence;
      caveat = [caveat, 'Columns were read from the deparsed plan predicate, not the SQL.']
        .filter((c): c is string => c !== null)
        .join(' ');
    }
    refined.push({
      ...candidate,
      confidence,
      caveat,
      source,
      existingState: 'unknown',
      existing: null,
      existingAdvice: null,
    });
  }
  if (refined.length === 0) return [];

  const probeCandidates: StatisticsProbeCandidate[] = refined.map((f) => ({
    relation: f.relation,
    columns: f.columns,
    ratio: f.ratio,
  }));
  let checks;
  try {
    checks = await db.readOnlySession(async (client) => {
      const probe = buildStatisticsProbe(probeCandidates);
      const rows = (await client.query<StatisticsProbeRow>(probe.text, probe.values)).rows;
      return interpretStatisticsProbe(probeCandidates, rows);
    });
  } catch (err) {
    const failure = statisticsProbeUnavailable(err instanceof Error ? err.message : String(err));
    checks = probeCandidates.map(() => failure);
  }

  return refined.map((finding, i) => {
    const check = checks[i] ?? statisticsProbeUnavailable('probe returned no row');
    return {
      ...finding,
      ddl: check.ddlOverride ?? finding.ddl,
      existingState: check.existingState,
      existing: check.existing,
      existingAdvice: check.existingAdvice,
    };
  });
}

export interface WhatIfResult {
  before: QueryPlan;
  after: QueryPlan;
  diff: PlanDiff;
  /** What was changed to produce `after`. */
  change:
    | { kind: 'index'; ddl: string }
    | { kind: 'settings'; settings: Record<string, string> }
    | { kind: 'rewrite'; sql: string }
    | { kind: 'statistics'; ddl: string };
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
      // poison every later query on it. hypopg's state survives ROLLBACK, so if
      // the after-EXPLAIN aborted the transaction (a timeout behind concurrent
      // DDL), the reset must still run — roll back to a clean state first.
      try {
        await client.query('SELECT hypopg_reset()');
      } catch {
        try {
          await client.query('ROLLBACK');
          await client.query('SELECT hypopg_reset()');
        } catch {
          // The connection is unusable; readOnlySession releases it and a dead
          // backend clears its own hypopg state.
        }
      }
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
 * Prove a CREATE STATISTICS suggestion on the opt-in sandbox.
 *
 * Nothing hypothetical exists for extended statistics, so this is the one
 * what-if that needs real DDL — which is exactly what the main connection must
 * never be able to run. The sandbox is a second, explicitly configured
 * credential (QUERYNOT_SANDBOX_URL) pointing at a disposable copy; without it
 * the endpoint refuses with the manual recipe and the advice stands on its own.
 *
 * One transaction, always rolled back: before-EXPLAIN ANALYZE, CREATE
 * STATISTICS qn_proof_stats, ANALYZE <table>, after-EXPLAIN ANALYZE, a bonus
 * in-transaction read of the computed dependency degrees, ROLLBACK (issued by
 * the session wrapper's finally). The diffed quantity is estimate accuracy
 * first — estimated rows moving toward actual on the matched node — with the
 * plan-cost verdict riding separately in the embedded diff.
 *
 * The client sends only coordinates ({sql, relation, columns}); every
 * statement that reaches the sandbox is composed server-side from quoteIdent'd
 * validated parts, and the candidate is re-derived from the SQL's AST — a
 * proof can only ever describe this agent's own advice.
 */
export async function whatIfStatistics(
  sandbox: Database | null,
  sql: string,
  relation: string,
  columnsInput: unknown,
): Promise<StatisticsProof> {
  if (!sandbox) {
    throw new AgentError(
      'No sandbox database is configured — CREATE STATISTICS cannot be tested hypothetically, and the agent\'s own role is read-only by design.',
      'Point QUERYNOT_SANDBOX_URL at a disposable copy of the database (never production). Manual recipe: run the ' +
        'suggested CREATE STATISTICS and ANALYZE there, re-run EXPLAIN (ANALYZE, BUFFERS), and compare estimated vs ' +
        'actual rows on the scan.',
      412,
    );
  }

  const admission = admitQuery(sql);
  if (!admission.ok) throw new AgentError(admission.reason ?? 'Query refused.');

  const colCheck = validateStatisticsColumns(columnsInput);
  if (!colCheck.ok) throw new AgentError(colCheck.reason);
  const columns = columnsInput as string[];

  // Re-derive the candidate server-side: if the SQL no longer pins exactly
  // these columns as an equality conjunction on this relation, the client is
  // holding stale coordinates — a conflict, not a guess.
  const confirmation = confirmConjunctionFromAst(sql, relation, null, columns);
  if (confirmation.verdict !== 'confirmed') {
    throw new AgentError(
      'The SQL no longer produces this candidate — re-run the analysis.',
      confirmation.reason,
      409,
    );
  }

  const statement = sql.trim().replace(/;\s*$/, '');
  const proofDdl = buildProofDdl(relation, columns);

  let session: {
    before: QueryPlan;
    after: QueryPlan;
    database: string;
    dependency: { pairs: DependencyPair[]; raw: string } | null;
  };
  try {
    // allowWrites opens a plain BEGIN — the transaction cannot be READ ONLY
    // because CREATE STATISTICS is DDL — while SET LOCAL statement_timeout and
    // the unconditional ROLLBACK in the session's finally still apply exactly
    // as on the main path. Running without the read-only backstop is
    // acceptable here and only here because the statement passed admitQuery,
    // every other statement is composed from validated identifiers above, and
    // the sandbox is opt-in and disposable by contract.
    session = await sandbox.readOnlySession(
      async (client) => {
        const explain = async (): Promise<QueryPlan> => {
          const res = await client.query<Record<string, unknown>>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
          );
          const row = res.rows[0];
          if (!row) throw new AgentError('EXPLAIN returned no rows.', null, 500);
          return parseExplainJson(Object.values(row)[0] as unknown, statement);
        };

        const before = await explain();
        await client.query(proofDdl.create);
        await client.query(proofDdl.analyze);
        const after = await explain();

        const db = await client.query<{ db: string }>('SELECT current_database() AS db');

        // The dependency citation is a bonus, never a gate: the transaction
        // sees its own uncommitted object, but a lagging pg_stats_ext or an
        // odd search_path must not fail a proof that already measured.
        let dependency: { pairs: DependencyPair[]; raw: string } | null = null;
        try {
          const evidence = buildDependencyEvidenceSql();
          const rows = await client.query<{ deps: string | null; colnames: string[] | null; attnums: string | null }>(
            evidence.text,
            evidence.values,
          );
          const row = rows.rows[0];
          const pairs = parseDependencies(row?.deps ?? null, row?.attnums ?? null, row?.colnames ?? null);
          if (pairs && row?.deps) dependency = { pairs, raw: row.deps };
        } catch {
          // Swallowed on purpose.
        }

        return { before, after, database: db.rows[0]?.db ?? 'unknown', dependency };
      },
      { allowWrites: true },
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42501') {
      throw new AgentError(
        'The sandbox role may not create statistics on that table.',
        `CREATE STATISTICS and in-transaction ANALYZE both require the sandbox role to own ${relation} ` +
          '(PG16’s MAINTAIN privilege covers ANALYZE only). Transfer ownership on the sandbox copy, or connect as the owner.',
      );
    }
    if (code === '57014') {
      throw new AgentError(
        'The proof exceeded the agent’s statement timeout.',
        'The sandbox ANALYZE samples the whole table and the query runs twice under EXPLAIN ANALYZE. ' +
          'Raise QUERYNOT_STATEMENT_TIMEOUT_MS, or point the sandbox at a smaller copy.',
      );
    }
    throw err;
  }

  const { before, after, database, dependency } = session;
  const beforeNode = pickTargetNode(before, relation, columns);
  const afterNode = pickTargetNode(after, relation, columns);

  const side = (node: typeof beforeNode): StatisticsAccuracySide | null =>
    node && node.misestimate !== null && node.actualRowsTotal !== null
      ? { estimatedRows: node.estimatedRowsTotal, actualRows: node.actualRowsTotal, ratio: node.misestimate }
      : null;
  const beforeSide = side(beforeNode);
  const afterSide = side(afterNode);
  const accuracy =
    beforeSide && afterSide && beforeNode
      ? { before: beforeSide, after: afterSide, nodeLabel: describeNode(beforeNode) }
      : null;

  const diff = diffPlans(before, after);
  const planDiff: WhatIfResult = {
    before,
    after,
    diff,
    change: { kind: 'statistics', ddl: proofDdl.create },
    findingsAfter: analyze(after),
    // Both sides executed — on the sandbox, which the note names.
    costOnly: false,
    note:
      'Both plans were executed on the sandbox, so this comparison is measured there. Run it more than once — ' +
      'a first run pays cold-cache costs the second does not.',
  };

  return {
    ddl: proofDdl.create,
    adviceDdl: buildAdviceDdl(relation, columns),
    relation,
    columns,
    outcome: classifyOutcome(beforeSide, afterSide),
    accuracy,
    accuracyUnavailableReason: accuracy
      ? null
      : `No ${beforeSide ? 'after' : 'before'}-plan node on \`${relation}\` carried a measurable estimate for these columns — the plan diff below is the whole comparison.`,
    dependency,
    planDiff,
    sandbox: { database },
    note: composeStatisticsNote(database, relation),
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
    // Each spec kind has its own probe; the verdicts reassemble in the order
    // the transform declared them, which is the order the argument reads in.
    const columnSpecs = candidate.preconditions.filter(
      (p): p is ColumnPrecondition => p.kind === 'column-not-null' || p.kind === 'column-type-supported',
    );
    const uniqueSpecs = candidate.preconditions.filter(
      (p): p is UniqueKeyPrecondition => p.kind === 'unique-key-covers',
    );
    const aggSpecs = candidate.preconditions.filter(
      (p): p is AggregatePrecondition => p.kind === 'function-not-aggregate',
    );
    const isAggSpecs = candidate.preconditions.filter(
      (p): p is IsAggregatePrecondition => p.kind === 'function-is-aggregate',
    );

    const tz =
      (await client.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)).rows[0]?.tz ?? 'UTC';

    const bySpec = new Map<unknown, PreconditionCheck>();
    if (columnSpecs.length > 0) {
      const probe = buildCatalogProbe(columnSpecs);
      const rows = (await client.query<CatalogRow>(probe.text, probe.values)).rows;
      for (const c of interpretChecks(columnSpecs, rows, { timeZone: tz })) bySpec.set(c.spec, c);
    }
    if (uniqueSpecs.length > 0) {
      const probe = buildUniqueIndexProbe(uniqueSpecs);
      const rows = (await client.query<UniqueIndexRow>(probe.text, probe.values)).rows;
      for (const c of interpretUniqueChecks(uniqueSpecs, rows)) bySpec.set(c.spec, c);
    }
    if (aggSpecs.length > 0 || isAggSpecs.length > 0) {
      // One probe serves both directions of the aggregate question.
      const names = [...new Set([...aggSpecs, ...isAggSpecs].flatMap((s) => s.functions))];
      const probe = buildAggregateProbe(names);
      const rows = (await client.query<{ proname: string }>(probe.text, probe.values)).rows;
      const aggNames = rows.map((r) => r.proname);
      for (const c of interpretAggregateChecks(aggSpecs, aggNames)) bySpec.set(c.spec, c);
      for (const c of interpretIsAggregateChecks(isAggSpecs, aggNames)) bySpec.set(c.spec, c);
    }
    const preconditions = candidate.preconditions
      .map((p) => bySpec.get(p))
      .filter((c): c is PreconditionCheck => c !== undefined);

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
        // coincidence, the schema fact is why it cannot be, here. A rewrite
        // with no preconditions (the OR split) is exact by construction, and
        // the sentence should claim that rather than trail off.
        const why = established.length > 0
          ? `Safe because ${established}.`
          : 'Safe by construction — the guards make the arms mutually exclusive, so no schema fact is needed.';
        note = `${diff.summary.headline} ${why} ${sentence(equivalence.note)}`;
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
 * Sweep one predicate's constant along the column's own statistics and re-plan
 * at each point — parameter sensitivity.
 *
 * NEVER ANALYZE, structurally: the EXPLAIN string below is hard-coded without
 * it. Two reasons, both also in the response note. (a) Executing the sweep
 * runs the user's query once per point, and a p10 range constant can select
 * ~90% of a large table — production cost multiplied by the variant count.
 * (b) The flip is a planner phenomenon: the decision boundary lives in the
 * cost model, and plain EXPLAIN reports the exact numbers the planner decided
 * with. Execution would add wall-clock noise, not evidence.
 *
 * Nothing is written to the Store: a sweep is diagnosis with nothing
 * appliable — decisions record changes with verdicts, and "the plan flips at
 * 49042" is not a change anyone ships. Catalog facts are read fresh, in the
 * same session as the EXPLAINs, so unqualified names resolve through exactly
 * the search_path the query gets, and are never cached across requests.
 */
export async function whatIfParameterSensitivity(
  db: Database,
  sql: string,
  location: number | null = null,
): Promise<SensitivityResult> {
  const admission = admitQuery(sql);
  if (!admission.ok) throw new AgentError(admission.reason ?? 'Query refused.');

  let tree: unknown;
  try {
    tree = parseSync(sql);
  } catch (err) {
    const e = err as { message?: string; cursorPosition?: number };
    throw new SqlParseError(e?.message ?? String(err), e?.cursorPosition ?? null);
  }

  // A parameterised query has no value to vary — and EXPLAIN would refuse it
  // anyway. Refuse with the fix rather than a syntax error later.
  if (hasParamRef(tree)) {
    throw new AgentError(
      'This query is parameterised — a $n placeholder has no value to vary.',
      'Substitute a representative literal for each parameter and re-run the sweep.',
    );
  }

  const discovered = discoverPredicates(sql, tree);
  if (discovered.length === 0) {
    throw new AgentError(
      'The top-level WHERE clause contains no column-to-constant comparison to sweep.',
      'Sensitivity varies a literal compared against a base-table column with = < <= > or >= — e.g. total_cents > 495000.',
    );
  }

  // An explicit pin overrides the choice; a pin that matches nothing is stale
  // coordinates, the same conflict whatIfRewrite reports.
  let pinned: number | null = null;
  if (location !== null) {
    pinned = discovered.findIndex((d) => d.candidate.location === location);
    if (pinned < 0) {
      throw new AgentError('The SQL no longer contains a comparison at that position — re-run the analysis.', null, 409);
    }
    const skipped = discovered[pinned].candidate.skipped;
    if (skipped !== null) {
      throw new AgentError(`That comparison cannot be swept: ${skipped}.`);
    }
  }

  const describeCandidate = (c: { column: string | null; operator: string | null; value: string | null; skipped: string | null }): string =>
    `\`${c.column ?? '?'} ${c.operator ?? '?'} ${c.value ?? '…'}\` — ${c.skipped ?? ''}`;

  const usable = discovered
    .map((d, index) => ({ ...d, index }))
    .filter((d): d is typeof d & { site: PredicateSite } => d.site !== null);
  if (usable.length === 0) {
    throw new AgentError(
      `Comparisons were found, but none can be swept: ${discovered.map((d) => describeCandidate(d.candidate)).join('; ')}.`,
    );
  }

  const statement = sql.trim().replace(/;\s*$/, '');

  const session = await db.readOnlySession(async (client) => {
    // Stats probe in the SAME session as the EXPLAINs: to_regclass resolves
    // through this session's search_path — the resolution the query gets.
    const probe = buildStatsProbe(usable.map((u) => u.site));
    const rows = (await client.query<StatsRow>(probe.text, probe.values)).rows;
    const stats = interpretStats(usable.map((u) => u.site), rows);

    // Sites whose statistics cannot support a sweep become skipped candidates
    // with the pg_stats evidence as the reason — reported, never dropped.
    const eligible: Array<{ site: PredicateSite; stats: (typeof stats)[number]; index: number }> = [];
    stats.forEach((s, i) => {
      if (s.basis !== null) eligible.push({ site: usable[i].site, stats: s, index: usable[i].index });
      else discovered[usable[i].index].candidate.skipped = s.evidence;
    });

    if (pinned !== null) {
      const hit = eligible.find((e) => e.index === pinned);
      if (!hit) {
        throw new AgentError(`That comparison cannot be swept: ${discovered[pinned].candidate.skipped ?? 'its statistics are unusable'}.`);
      }
    }
    if (eligible.length === 0) {
      throw new AgentError(
        `Comparisons were found, but none can be swept: ${discovered.map((d) => describeCandidate(d.candidate)).join('; ')}.`,
        'ANALYZE the table if pg_stats has no rows for these columns.',
      );
    }

    let chosenAt: number;
    let why: string;
    if (pinned !== null) {
      chosenAt = eligible.findIndex((e) => e.index === pinned);
      why = `pinned by request to the comparison at byte offset ${location}`;
    } else {
      const choice = chooseSite(eligible.map((e) => ({ site: e.site, stats: e.stats })));
      chosenAt = choice.index;
      why = choice.why;
    }
    const chosen = eligible[chosenAt];
    discovered[chosen.index].candidate.chosen = true;

    const build = buildVariants(sql, chosen.site, chosen.stats);
    if (!build.ok) throw new AgentError(build.refusal, null, build.refusal.includes('agent bug') ? 500 : 400);

    // Generated output is untrusted by design: every variant passes the same
    // admission gate as user input, and a failure is a 500 — an agent bug,
    // never a quiet downgrade (whatIfRewrite's treatment of its own output).
    for (const variant of build.variants) {
      const variantAdmission = admitQuery(variant.sql);
      if (!variantAdmission.ok) {
        throw new AgentError(`A generated variant failed admission: ${variantAdmission.reason}`, null, 500);
      }
    }

    const explain = async (text: string): Promise<QueryPlan> => {
      // Plain EXPLAIN only — see the function comment for why ANALYZE never
      // appears in this string.
      const res = await client.query<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${text}`);
      const row = res.rows[0];
      if (!row) throw new AgentError('EXPLAIN returned no rows.', null, 500);
      return parseExplainJson(Object.values(row)[0] as unknown, text);
    };

    const baselinePlan = await explain(statement);
    const variantPlans: QueryPlan[] = [];
    for (const variant of build.variants) {
      variantPlans.push(await explain(variant.sql.trim().replace(/;\s*$/, '')));
    }

    return { chosen, why, build, baselinePlan, variantPlans };
  });

  const { chosen, why, build, baselinePlan, variantPlans } = session;
  const site = chosen.site;

  const scanRowsOf = (plan: QueryPlan): number | null => {
    const relname = site.relation.at(-1);
    const scan = plan.nodes.find((n) => n.nodeType.endsWith('Scan') && n.relation === relname);
    return scan ? scan.estimatedRowsTotal : null;
  };

  const signatures = variantPlans.map(accessSignature);
  const points: FlipPoint[] = build.variants.map((v: VariantSpec, i: number) => ({
    label: v.label,
    value: v.value,
    signature: signatures[i],
    totalCost: variantPlans[i].totalCost,
    estimatedRows: variantPlans[i].root.estimatedRowsTotal,
  }));
  const flips = findFlips(points, site);

  // Payload discipline: full plans + diffs only for the two points flanking
  // the FIRST flip boundary; with no flip, the baseline plan ships instead.
  let firstFlipAt = -1;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i].signature;
    const b = points[i + 1].signature;
    if (a.length !== b.length || a.some((x, j) => x !== b[j])) {
      firstFlipAt = i;
      break;
    }
  }
  const flank = new Set(firstFlipAt >= 0 ? [firstFlipAt, firstFlipAt + 1] : []);

  const diffs = variantPlans.map((p) => diffPlans(baselinePlan, p));
  const variants: SensitivityVariant[] = build.variants.map((v: VariantSpec, i: number) => ({
    label: v.label,
    value: v.value,
    sql: v.sql,
    frequency: v.frequency,
    verdict: diffs[i].summary.verdict,
    totalCost: variantPlans[i].totalCost,
    estimatedRows: variantPlans[i].root.estimatedRowsTotal,
    scanRows: scanRowsOf(variantPlans[i]),
    signature: signatures[i],
    plan: flank.has(i) ? variantPlans[i] : null,
    diff: flank.has(i) ? diffs[i] : null,
  }));

  const baselineSignature = accessSignature(baselinePlan);
  const baselineMatch = points.find((p) =>
    p.signature.length === baselineSignature.length && p.signature.every((x, j) => x === baselineSignature[j]));
  const baseline: SensitivityVariant = {
    label: 'as written',
    value: site.literalText,
    sql: statement,
    frequency: null,
    verdict: null,
    totalCost: baselinePlan.totalCost,
    estimatedRows: baselinePlan.root.estimatedRowsTotal,
    scanRows: scanRowsOf(baselinePlan),
    signature: baselineSignature,
    plan: firstFlipAt < 0 ? baselinePlan : null,
    diff: null,
  };

  const narrative = composeNarrative({
    site,
    stats: chosen.stats,
    evidence: chosen.stats.evidence,
    points,
    flips,
    baselineMatchesLabel: baselineMatch?.label ?? null,
    notes: build.notes,
  });

  return {
    predicate: {
      column: site.column,
      relation: site.relation,
      operator: site.operator,
      originalValue: site.literalText,
      location: site.location,
      charSpan: site.charSpan,
      why,
    },
    candidates: discovered.map((d) => d.candidate),
    basis: {
      kind: chosen.stats.basis as 'histogram' | 'mcv',
      evidence: chosen.stats.evidence,
      nDistinct: chosen.stats.nDistinct,
      nullFrac: chosen.stats.nullFrac,
      reltuples: chosen.stats.reltuples,
    },
    baseline,
    variants,
    flips,
    baselineMatchesLabel: baselineMatch?.label ?? null,
    narrative,
    costOnly: true,
    note: SENSITIVITY_NOTE,
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
