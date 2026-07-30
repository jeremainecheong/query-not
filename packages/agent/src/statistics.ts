/**
 * The extended-statistics advisor's pure parts.
 *
 * Three concerns, all side-effect free (catalog.ts's construction/
 * interpretation pattern — the round trips live in explain.ts):
 *
 *   1. AST confirmation — the core suggestion read its columns from deparsed
 *      plan text; this re-checks them against the SQL itself, so advice is
 *      upgraded, downgraded, or dropped instead of guessed at.
 *   2. Catalog probe — does a covering pg_statistic_ext object already exist,
 *      and what state is it in? Interpretation is careful about what the
 *      catalogs can actually tell a non-superuser (see the pg_stats_ext note).
 *   3. Proof plumbing — DDL composition from validated parts, dependency-
 *      evidence parsing, target-node matching, and outcome classification for
 *      the sandbox prove flow.
 */

import {
  composeExtendedStatisticsDdl,
  formatRatio,
  type ExtStatsSuggestion,
  type PlanNode,
  type QueryPlan,
} from '@query-not/core';
import { parseSync } from 'libpg-query';

import { quoteIdent } from './transform.ts';
import type { WhatIfResult } from './explain.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type ExistingStatisticsState =
  | 'none'
  | 'not-analysed'
  | 'analysed'
  | 'wrong-kind'
  | 'not-visible'
  | 'unknown';

/** A core suggestion refined by the agent: AST-confirmed and catalog-checked. */
export interface StatisticsFinding extends ExtStatsSuggestion {
  /** Where the columns were read from. 'plan-text' is the degraded path. */
  source: 'ast' | 'plan-text';
  existingState: ExistingStatisticsState;
  /** The covering statistics object, when one exists. */
  existing: { name: string; columns: string[]; kinds: string[] } | null;
  /** The state-specific advice sentence, when the state changes the advice. */
  existingAdvice: string | null;
}

export type StatisticsProofOutcome = 'estimates-fixed' | 'estimates-improved' | 'no-effect';

export interface StatisticsAccuracySide {
  estimatedRows: number;
  actualRows: number;
  /** Estimate-vs-actual ratio >= 1, straight off the parsed node. */
  ratio: number;
}

export interface StatisticsAccuracy {
  before: StatisticsAccuracySide;
  after: StatisticsAccuracySide;
  nodeLabel: string;
}

export interface DependencyPair {
  determinant: string[];
  dependent: string;
  degree: number;
}

export interface StatisticsProof {
  /** The statement that ran on the sandbox (fixed name, always rolled back). */
  ddl: string;
  /** The durable form to actually ship: named object plus its ANALYZE. */
  adviceDdl: string;
  relation: string;
  columns: string[];
  outcome: StatisticsProofOutcome;
  accuracy: StatisticsAccuracy | null;
  accuracyUnavailableReason: string | null;
  /** Functional-dependency degrees read back in-transaction, when readable. */
  dependency: { pairs: DependencyPair[]; raw: string } | null;
  planDiff: WhatIfResult;
  sandbox: { database: string };
  note: string;
}

// ── AST confirmation ─────────────────────────────────────────────────────────

type Node = Record<string, any>;

export type ConjunctionVerdict = 'confirmed' | 'contradicted' | 'unresolved';

export interface ConjunctionCheck {
  verdict: ConjunctionVerdict;
  /** Equality-conjunct columns found for the relation, conjunct order. */
  columns: string[];
  reason: string;
}

const asNode = (v: unknown): Node | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : null;

/** Every SelectStmt in the tree, including subqueries and CTE bodies. */
function collectSelects(root: unknown): Node[] {
  const out: Node[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    const n = asNode(v);
    if (!n) return;
    for (const [key, value] of Object.entries(n)) {
      if (key === 'SelectStmt' && asNode(value)) out.push(value as Node);
      walk(value);
    }
  };
  walk(root);
  return out;
}

interface ScopeEntry {
  relname: string;
  alias: string | null;
}

/** Plain range vars of one scope's FROM — join arms included, subselects not. */
function scopeRangeVars(from: unknown): ScopeEntry[] {
  const out: ScopeEntry[] = [];
  const visit = (v: unknown): void => {
    const n = asNode(v);
    if (!n) return;
    const rv = asNode(n['RangeVar']);
    if (rv && typeof rv['relname'] === 'string') {
      out.push({
        relname: rv['relname'],
        alias: (asNode(rv['alias'])?.['aliasname'] as string | undefined) ?? null,
      });
      return;
    }
    const je = asNode(n['JoinExpr']);
    if (je) {
      visit(je['larg']);
      visit(je['rarg']);
    }
    // A RangeSubselect is its own scope; its SelectStmt is visited separately.
  };
  if (Array.isArray(from)) for (const item of from) visit(item);
  return out;
}

/** Flatten a WHERE clause's top-level AND chain (AND of ANDs, recursively). */
function topLevelConjuncts(where: unknown): Node[] {
  const n = asNode(where);
  if (!n) return [];
  const bool = asNode(n['BoolExpr']);
  if (bool && bool['boolop'] === 'AND_EXPR' && Array.isArray(bool['args'])) {
    return bool['args'].flatMap((arg: unknown) => topLevelConjuncts(arg));
  }
  return [n];
}

/** ColumnRef → its name parts, or null when the node is not a plain column. */
function columnRefParts(v: unknown): string[] | null {
  const ref = asNode(asNode(v)?.['ColumnRef']);
  if (!ref || !Array.isArray(ref['fields'])) return null;
  const parts = ref['fields']
    .map((f: unknown) => asNode(f)?.['String']?.['sval'])
    .filter((s: unknown): s is string => typeof s === 'string');
  return parts.length > 0 ? parts : null;
}

/** True when any ColumnRef appears anywhere in the subtree. */
function subtreeHasColumnRef(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((item) => subtreeHasColumnRef(item));
  const n = asNode(v);
  if (!n) return false;
  for (const [key, value] of Object.entries(n)) {
    if (key === 'ColumnRef') return true;
    if (subtreeHasColumnRef(value)) return true;
  }
  return false;
}

/**
 * Confirm that `columns` really are a top-level equality conjunction on
 * `relation` in this SQL — the AST check behind both the advice confidence and
 * the prove endpoint's stale-candidate 409.
 *
 * A conjunct counts when it is `A_Expr '='` with exactly one side a ColumnRef
 * resolving to the target relation and the other side free of ColumnRefs
 * (a constant, parameter, or constant expression — `col = col2` is not a
 * dependency-fixable predicate and is rejected). OR arms are excluded by
 * construction: their equalities are not top-level conjuncts.
 *
 * `alias` is the plan node's alias when known; pass null to accept any alias
 * bound to the relation. Verdicts: 'confirmed' when some SELECT scope holds
 * every candidate column; 'contradicted' when the relation is in scope
 * somewhere but no scope holds them (they live under an OR, or span
 * relations); 'unresolved' when the relation is nowhere in the tree (a view,
 * a CTE — the parser cannot see through it).
 */
export function confirmConjunctionFromAst(
  sql: string,
  relation: string,
  alias: string | null,
  columns: string[],
): ConjunctionCheck {
  const tree = parseSync(sql) as Node;
  const selects = collectSelects(tree);

  let relationSeen = false;
  let best: string[] = [];

  for (const select of selects) {
    const scope = scopeRangeVars(select['fromClause']);
    const targets = scope.filter(
      (e) => e.relname === relation && (alias === null || (e.alias ?? e.relname) === alias),
    );
    if (targets.length === 0) continue;
    relationSeen = true;

    // Names that address the target in this scope, and whether an unqualified
    // column can only mean the target (single range var in the scope).
    const targetNames = new Set(targets.map((e) => e.alias ?? e.relname));
    const unqualifiedOk = scope.length === 1;

    const found: string[] = [];
    for (const conjunct of topLevelConjuncts(select['whereClause'])) {
      const expr = asNode(conjunct['A_Expr']);
      if (!expr) continue;
      const op = Array.isArray(expr['name'])
        ? asNode(expr['name'][expr['name'].length - 1])?.['String']?.['sval']
        : null;
      if (op !== '=') continue;

      for (const [side, other] of [
        ['lexpr', 'rexpr'],
        ['rexpr', 'lexpr'],
      ] as const) {
        const parts = columnRefParts(expr[side]);
        if (!parts) continue;
        // Constant side must hold no column at all — col = col is refused.
        if (subtreeHasColumnRef(expr[other])) continue;

        const column = parts[parts.length - 1] as string;
        const qualifier = parts.length >= 2 ? (parts[parts.length - 2] as string) : null;
        const resolves = qualifier !== null ? targetNames.has(qualifier) : unqualifiedOk;
        if (resolves && !found.includes(column)) found.push(column);
        break;
      }
    }

    if (columns.every((c) => found.includes(c))) {
      return {
        verdict: 'confirmed',
        columns: found,
        reason: `the SQL's WHERE holds ${columns.map((c) => `\`${c}\``).join(', ')} as top-level equality conjuncts on \`${relation}\``,
      };
    }
    if (found.length > best.length) best = found;
  }

  if (relationSeen) {
    return {
      verdict: 'contradicted',
      columns: best,
      reason:
        `\`${relation}\` is in the SQL, but ${columns.map((c) => `\`${c}\``).join(', ')} are not all top-level ` +
        'equality conjuncts on it — they may sit under an OR, compare column to column, or span relations',
    };
  }
  return {
    verdict: 'unresolved',
    columns: [],
    reason: `\`${relation}\` does not appear as a plain table in the SQL's FROM clauses (a view or CTE the parser cannot see through)`,
  };
}

// ── Catalog probe ────────────────────────────────────────────────────────────

export interface StatisticsProbeCandidate {
  relation: string;
  columns: string[];
  /** The measured ratio, threaded into the exists-and-analysed advice. */
  ratio: number;
}

/** One row of the probe result, per candidate index. */
export interface StatisticsProbeRow {
  idx: number;
  rel_exists: boolean;
  stats_schema: string | null;
  stats_name: string | null;
  stats_columns: string[] | null;
  /** stxkind letters joined with ',' — d=ndistinct, f=dependencies, m=mcv, e=expressions. */
  kinds: string | null;
  visible_rows: number | null;
  populated: boolean | null;
}

/**
 * For each candidate, the tightest covering statistics object and its state.
 *
 * Two catalogs on purpose. pg_statistic_ext (definitions) is readable by any
 * role; the computed data lives in pg_statistic_ext_data, superuser-only since
 * PG12, so state is read through the pg_stats_ext VIEW — which drops the
 * whole row when the role lacks SELECT on any covered column or row security
 * is active. Zero view rows for an existing definition is therefore reported
 * as 'not-visible', never as "not analysed". The view is aggregated with
 * count(*)/bool_or and no `inherited` column is selected, because PG15+
 * stxdinherit yields two rows per object and the column does not exist before
 * PG15. Coverage is candidate-columns ⊆ stxkeys — dependencies are computed
 * for column subsets within an object — preferring populated, then tightest.
 */
export function buildStatisticsProbe(candidates: StatisticsProbeCandidate[]): {
  text: string;
  values: [string];
} {
  const payload = candidates.map((c) => ({ rel: quoteIdent(c.relation), cols: c.columns }));
  return {
    text: `
      SELECT (e.idx - 1)::int                              AS idx,
             to_regclass(e.spec->>'rel') IS NOT NULL       AS rel_exists,
             best.stats_schema, best.stats_name, best.stats_columns, best.kinds,
             best.visible_rows, best.populated
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(spec, idx)
      LEFT JOIN LATERAL (
        SELECT sn.nspname AS stats_schema,
               s.stxname  AS stats_name,
               (SELECT array_agg(a.attname::text ORDER BY a.attnum)
                  FROM unnest(s.stxkeys) k
                  JOIN pg_attribute a ON a.attrelid = s.stxrelid AND a.attnum = k) AS stats_columns,
               array_to_string(s.stxkind, ',') AS kinds,
               (SELECT count(*)::int FROM pg_stats_ext v
                 WHERE v.statistics_schemaname = sn.nspname AND v.statistics_name = s.stxname) AS visible_rows,
               (SELECT bool_or(v.n_distinct IS NOT NULL OR v.dependencies IS NOT NULL)
                  FROM pg_stats_ext v
                 WHERE v.statistics_schemaname = sn.nspname AND v.statistics_name = s.stxname) AS populated
        FROM pg_statistic_ext s
        JOIN pg_namespace sn ON sn.oid = s.stxnamespace
        WHERE s.stxrelid = to_regclass(e.spec->>'rel')
          AND (SELECT array_agg(x) FROM jsonb_array_elements_text(e.spec->'cols') t(x))
              <@ (SELECT array_agg(a.attname::text) FROM unnest(s.stxkeys) k
                   JOIN pg_attribute a ON a.attrelid = s.stxrelid AND a.attnum = k)
        ORDER BY (SELECT bool_or(v.n_distinct IS NOT NULL OR v.dependencies IS NOT NULL)
                    FROM pg_stats_ext v
                   WHERE v.statistics_schemaname = sn.nspname AND v.statistics_name = s.stxname) DESC NULLS LAST,
                 cardinality(s.stxkeys)
        LIMIT 1
      ) best ON true
      ORDER BY idx
    `,
    values: [JSON.stringify(payload)],
  };
}

export interface ExistingStatisticsCheck {
  existingState: ExistingStatisticsState;
  existing: { name: string; columns: string[]; kinds: string[] } | null;
  existingAdvice: string | null;
  /** Replaces the suggestion's DDL when the right advice is not new DDL at all. */
  ddlOverride: string | null;
}

/** The shared unknown shape for a failed probe — advice ships, claiming nothing. */
export function statisticsProbeUnavailable(error: string): ExistingStatisticsCheck {
  return {
    existingState: 'unknown',
    existing: null,
    existingAdvice:
      `Could not read the statistics catalogs on this database (${error}) — ` +
      'no claim is made about existing statistics objects.',
    ddlOverride: null,
  };
}

/**
 * Turn probe rows into per-candidate states, each with its advice sentence.
 *
 * Exists-but-not-analysed is different advice, not a variant sentence: the
 * fix is `ANALYZE <table>`, so that replaces the DDL. Exists-and-analysed
 * keeps the misestimate honest with labelled hypotheses rather than a claim.
 */
export function interpretStatisticsProbe(
  candidates: StatisticsProbeCandidate[],
  rows: StatisticsProbeRow[],
): ExistingStatisticsCheck[] {
  const byIdx = new Map<number, StatisticsProbeRow>();
  for (const r of rows) byIdx.set(Number(r.idx), r);

  return candidates.map((candidate, i) => {
    const row = byIdx.get(i);
    if (!row || !row.stats_name) {
      return { existingState: 'none' as const, existing: null, existingAdvice: null, ddlOverride: null };
    }

    const kinds = (row.kinds ?? '').split(',').filter((k) => k.length > 0);
    const existing = {
      name: row.stats_name,
      columns: row.stats_columns ?? [],
      kinds,
    };
    const name = `\`${row.stats_name}\``;
    const cols = (row.stats_columns ?? []).join(', ');

    // stxkind letters: d=ndistinct, f=dependencies, m=mcv, e=expressions —
    // the obvious guess is backwards. Only f or m can inform WHERE selectivity.
    if (!kinds.includes('f') && !kinds.includes('m')) {
      return {
        existingState: 'wrong-kind' as const,
        existing,
        existingAdvice:
          `${name} already covers (${cols}) but its kinds (${kinds.join(', ') || 'none'}) include neither ` +
          `dependencies nor mcv, so it cannot inform WHERE selectivity — and there is no ALTER STATISTICS ` +
          `to add kinds. Create a new object that includes dependencies.`,
        ddlOverride: null,
      };
    }

    if ((row.visible_rows ?? 0) === 0) {
      return {
        existingState: 'not-visible' as const,
        existing,
        existingAdvice:
          `A covering statistics object ${name} exists, but pg_stats_ext hides its state from this role ` +
          `(column privileges or row security) — cannot say whether it has been analysed.`,
        ddlOverride: null,
      };
    }

    if (row.populated === true) {
      return {
        existingState: 'analysed' as const,
        existing,
        existingAdvice:
          `${name} already covers (${cols}) and is populated, yet the estimate is still off ` +
          `${formatRatio(candidate.ratio)}. Likely causes — an estimate, not a measurement: the dependency ` +
          `may be partial, or the literal may fall outside the MCV list. Raising the statistics target or ` +
          `adding the \`mcv\` kind is the next lever.`,
        ddlOverride: null,
      };
    }

    const analyzeDdl = `ANALYZE ${quoteIdent(candidate.relation)};`;
    return {
      existingState: 'not-analysed' as const,
      existing,
      existingAdvice:
        `Run \`${analyzeDdl}\` — the object ${name} exists but pg_stats_ext shows its data has never been computed.`,
      ddlOverride: analyzeDdl,
    };
  });
}

// ── Prove plumbing ───────────────────────────────────────────────────────────

export function validateStatisticsColumns(columns: unknown): { ok: boolean; reason: string } {
  if (!Array.isArray(columns) || columns.length < 2 || columns.length > 8) {
    return { ok: false, reason: 'Provide "columns" as an array of 2–8 column names (the CREATE STATISTICS limits).' };
  }
  for (const c of columns) {
    if (typeof c !== 'string' || c.trim().length === 0 || c.length > 63 || c.includes('\0')) {
      return { ok: false, reason: 'Every column must be a plain identifier of at most 63 characters.' };
    }
  }
  if (new Set(columns).size !== columns.length) {
    return { ok: false, reason: 'Columns must be distinct.' };
  }
  return { ok: true, reason: '' };
}

/**
 * The statements the sandbox transaction runs, composed from quoteIdent'd
 * parts — the client only ever sends coordinates, never DDL. The object name
 * is fixed: it is always rolled back, and the sandbox pool of one connection
 * means two proofs can never collide on it.
 */
export function buildProofDdl(relation: string, columns: string[]): { create: string; analyze: string } {
  return {
    create: `CREATE STATISTICS qn_proof_stats (dependencies, ndistinct) ON ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(relation)}`,
    // Plain ANALYZE is legal in a transaction (VACUUM is not). Full-table on
    // purpose: column-list ANALYZE's extended-statistics behaviour varies by
    // version, and determinism beats a smaller sample here.
    analyze: `ANALYZE ${quoteIdent(relation)}`,
  };
}

/** The durable advice: the named object plus the ANALYZE that populates it. */
export function buildAdviceDdl(relation: string, columns: string[]): string {
  const { ddl } = composeExtendedStatisticsDdl(relation, columns);
  return `${ddl}\nANALYZE ${quoteIdent(relation)};`;
}

/**
 * Read the functional-dependency degrees back inside the proving transaction —
 * it sees its own uncommitted object, and the sandbox role owns it, so the
 * view shows it. Callers swallow failure: the citation is a bonus, never a gate.
 */
export function buildDependencyEvidenceSql(): { text: string; values: [string] } {
  return {
    text: `
      SELECT v.dependencies::text AS deps,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(s.stxkeys) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = s.stxrelid AND a.attnum = k.attnum) AS colnames,
             s.stxkeys::text AS attnums
      FROM pg_statistic_ext s
      JOIN pg_stats_ext v ON v.statistics_schemaname = s.stxnamespace::regnamespace::text
                         AND v.statistics_name = s.stxname
      WHERE s.stxname = $1
    `,
    values: ['qn_proof_stats'],
  };
}

/**
 * `{"2 => 3": 1.000000, "1, 2 => 3": 0.9}` plus stxkeys and their column
 * names → named dependency pairs. Attnums map to names positionally via
 * stxkeys order. Returns null rather than guessing when anything fails to parse.
 */
export function parseDependencies(
  depsText: string | null,
  attnumsText: string | null,
  colnames: string[] | null,
): DependencyPair[] | null {
  if (!depsText || !attnumsText || !colnames) return null;
  try {
    const attnums = attnumsText.trim().split(/\s+/).map(Number);
    if (attnums.length !== colnames.length || attnums.some(Number.isNaN)) return null;
    const nameOf = new Map<number, string>();
    attnums.forEach((n, i) => nameOf.set(n, colnames[i] as string));

    const parsed = JSON.parse(depsText) as Record<string, number>;
    const pairs: DependencyPair[] = [];
    for (const [key, degree] of Object.entries(parsed)) {
      const [lhs, rhs] = key.split('=>').map((s) => s.trim());
      if (!lhs || !rhs) return null;
      const determinant = lhs.split(',').map((s) => nameOf.get(Number(s.trim())));
      const dependent = nameOf.get(Number(rhs));
      if (!dependent || determinant.some((d) => d === undefined)) return null;
      pairs.push({ determinant: determinant as string[], dependent, degree: Number(degree) });
    }
    return pairs.length > 0 ? pairs : null;
  } catch {
    return null;
  }
}

/**
 * The node a proof's accuracy claim is about: on the right relation, scoring
 * mentions of the candidate columns in its quals, tie-broken by misestimate.
 * Null rather than a guessed match when nothing on the relation qualifies.
 */
export function pickTargetNode(
  plan: QueryPlan,
  relation: string,
  columns: string[],
): PlanNode | null {
  let best: PlanNode | null = null;
  let bestScore = -1;
  for (const node of plan.nodes) {
    if (node.relation !== relation || node.neverExecuted) continue;
    const quals = [node.filter, node.indexCond, node.recheckCond]
      .filter((p): p is string => p !== null)
      .join(' ');
    let score = 0;
    for (const column of columns) {
      if (new RegExp(`\\b${column}\\b`, 'i').test(quals)) score++;
    }
    if (
      score > bestScore ||
      (score === bestScore && (node.misestimate ?? 0) > (best?.misestimate ?? 0))
    ) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The thing CREATE STATISTICS changes is estimates, so the outcome is about
 * estimates: fixed when the after-ratio is within 2x of reality, improved when
 * it at least halved, no-effect otherwise. The plan-cost verdict rides
 * separately in the embedded plan diff.
 */
export function classifyOutcome(
  before: StatisticsAccuracySide | null,
  after: StatisticsAccuracySide | null,
): StatisticsProofOutcome {
  if (!before || !after) return 'no-effect';
  if (after.ratio <= 2) return 'estimates-fixed';
  if (after.ratio <= before.ratio / 2) return 'estimates-improved';
  return 'no-effect';
}

/**
 * The proof's note: what ran, where, what rolled back, and the caveats that
 * keep the claim honest. Scoped to the sandbox database by name.
 */
export function composeStatisticsNote(database: string, relation: string): string {
  return (
    `Everything ran in one transaction on the sandbox database \`${database}\` and was rolled back — ` +
    `the statistics object never persists, and these numbers describe that copy of the data. ` +
    `The in-transaction ANALYZE resamples \`${relation}\`'s per-column statistics too, so the comparison ` +
    `includes that effect — and it holds a ShareUpdateExclusive lock on \`${relation}\` until the rollback, ` +
    `so point QUERYNOT_SANDBOX_URL at a disposable database, never production. The transaction cannot be ` +
    `READ ONLY (it creates the object), so the analysed query ran without that backstop; admission ` +
    `filtering, the statement timeout and the unconditional rollback still apply, and as always sequence ` +
    `advancement and externally-visible trigger effects do not roll back.`
  );
}
