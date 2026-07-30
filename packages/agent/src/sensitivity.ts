/**
 * Parameter sensitivity: plan the same query at several constants drawn from
 * the planner's own statistics, and show where the plan flips.
 *
 * This is the README's world-tuple made literal — params are part of
 * world = (schema, statistics, GUCs, params, extensions) — so it is a what-if
 * that perturbs params: perturb, re-plan, diff. The sweep values come from
 * `pg_stats` itself (histogram bound positions for range comparisons, the
 * most_common_vals list for equalities), which is what makes every claim here
 * citable: the tool never invents a constant, it replays the planner's own
 * picture of the column back at it.
 *
 * The module follows catalog.ts's split: everything here is pure construction
 * and interpretation — probe SQL builders, row interpreters, variant splicing,
 * flip detection, narration. The single read-only session that runs the probe
 * and the EXPLAINs lives in the orchestrator (explain.ts).
 *
 * Two hazards this file is shaped around:
 *
 *   1. **Byte offsets.** Splice arithmetic is on Buffer, exactly as in
 *      transform.ts — libpg_query reports UTF-8 byte offsets, and the café
 *      trap (splicing a JS string at a byte offset) is as real for a constant
 *      as for a subquery.
 *
 *   2. **anyarray extraction.** `pg_stats.histogram_bounds` comes back through
 *      the `::text::text[]` round-trip: array output quotes awkward elements
 *      (commas, quotes, spaces) and array input unquotes them, so element text
 *      is exact. The driver usually parses text[] for us; `parseArrayLiteral`
 *      is the defensive path for when it hands us the raw literal instead, and
 *      is unit-tested against the awkward cases.
 */

import { parseSync } from 'libpg-query';
import { formatPercent, formatRows, type PlanDiff, type QueryPlan, type Verdict } from '@query-not/core';

import { byteToCharIndex, literalEnd, quoteIdent, validateSplice } from './transform.ts';

type Node = Record<string, unknown>;

const node = (v: unknown): Node | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : null;

// ── types ────────────────────────────────────────────────────────────────────

/** A usable column-OP-constant comparison in the top-level WHERE. */
export interface PredicateSite {
  /** Byte offset of the comparison (the A_Expr) — the coordinate a client can pin. */
  location: number;
  /** Bare column name, for pg_stats.attname. */
  column: string;
  /** Qualified name parts of the relation it resolved to, e.g. ['public','orders']. */
  relation: string[];
  /** The quoted key to_regclass resolves — catalog.ts's relationKey idiom. */
  relationKey: string;
  operator: string;
  /** The original literal, verbatim, quotes included when it had them. */
  literalText: string;
  /** The literal's span in the byte domain the parser speaks. */
  literalByteSpan: { start: number; end: number };
  /** The same span in UTF-16 units, for highlighting in a browser. */
  charSpan: { start: number; end: number };
}

/** Every comparison the discovery walk saw, usable or not — never silently dropped. */
export interface PredicateCandidate {
  column: string | null;
  operator: string | null;
  value: string | null;
  location: number;
  chosen: boolean;
  /** Why this site cannot be swept; null when it can. */
  skipped: string | null;
}

export interface DiscoveredPredicate {
  candidate: PredicateCandidate;
  /** Present exactly when candidate.skipped === null. */
  site: PredicateSite | null;
}

/** What pg_stats says about one site's column, interpreted into a verdict. */
export interface SiteStats {
  reltuples: number;
  nullFrac: number | null;
  nDistinct: number | null;
  mcv: string[] | null;
  mcvFreqs: number[] | null;
  histogram: string[] | null;
  /** The evidence base a sweep would read, or null when the site cannot be swept. */
  basis: 'histogram' | 'mcv' | null;
  /** Citable sentence: what pg_stats holds, or exactly why the sweep refuses. */
  evidence: string;
}

export interface VariantSpec {
  label: string;
  /** The raw stats value (array element text, unquoted). */
  value: string;
  /** The single-quoted SQL literal that was spliced in. */
  literal: string;
  sql: string;
  /** Sampled frequency for MCV-drawn values; null for histogram positions. */
  frequency: number | null;
}

export type VariantBuild =
  | { ok: true; variants: VariantSpec[]; notes: string[] }
  | { ok: false; refusal: string };

/** One planned sweep point, reduced to what flip detection needs. */
export interface FlipPoint {
  label: string;
  value: string;
  signature: string[];
  totalCost: number;
  estimatedRows: number;
}

export interface FlipBoundary {
  fromLabel: string;
  toLabel: string;
  fromValue: string;
  toValue: string;
  before: string[];
  after: string[];
  costFrom: number;
  costTo: number;
  headline: string;
}

export interface SensitivityVariant {
  label: string;
  value: string;
  sql: string;
  frequency: number | null;
  /** Plan-diff verdict against the as-written baseline; null on the baseline itself. */
  verdict: Verdict | null;
  totalCost: number;
  estimatedRows: number;
  /** The varied relation's scan-node estimate, when one scan is identifiable. */
  scanRows: number | null;
  signature: string[];
  /**
   * Payload discipline: the full plan ships only for the two points flanking
   * the FIRST flip boundary (the pair worth reading node by node); when no
   * flip occurred, the baseline carries it instead. Everything else is summary.
   */
  plan: QueryPlan | null;
  /** Diff against the baseline, attached exactly where `plan` is. */
  diff: PlanDiff | null;
}

export interface SensitivityResult {
  predicate: {
    column: string;
    relation: string[];
    operator: string;
    originalValue: string;
    location: number;
    charSpan: { start: number; end: number };
    /** Why this predicate was the one swept. */
    why: string;
  };
  candidates: PredicateCandidate[];
  basis: {
    kind: 'histogram' | 'mcv';
    evidence: string;
    nDistinct: number | null;
    nullFrac: number | null;
    reltuples: number;
  };
  baseline: SensitivityVariant;
  /** Ordered sweep: histogram position for ranges, descending frequency for equalities. */
  variants: SensitivityVariant[];
  flips: FlipBoundary[];
  /**
   * Which sweep point shares the as-written plan's shape. The baseline is NOT
   * interleaved into the ordering — placing the original constant among typed
   * histogram bounds would need type-aware value parsing, and guessing there
   * is worse than reporting the shape match separately.
   */
  baselineMatchesLabel: string | null;
  narrative: string;
  costOnly: true;
  note: string;
}

/**
 * Why nothing is ever executed, stated once and shipped with every result.
 * (a) Executing the sweep runs the user's query once per point, and a p10
 * range constant can select ~90% of a large table — production cost times the
 * variant count. (b) The flip is a planner phenomenon: the decision boundary
 * lives in the cost model, and plain EXPLAIN reports the exact numbers the
 * planner decided with. Execution would add wall-clock noise, not evidence.
 */
export const SENSITIVITY_NOTE =
  'Nothing was executed: every figure is a planner estimate from plain EXPLAIN. ' +
  'Running the sweep for real would execute the query once per point — a p10 range constant can select most of a large table — ' +
  'and the flip itself is a planner phenomenon: the decision boundary lives in the cost model, whose exact numbers plain EXPLAIN already reports. ' +
  'Execution would add wall-clock noise, not evidence.';

// ── discovery ────────────────────────────────────────────────────────────────

const SWEEPABLE_OPS = new Set(['=', '<', '<=', '>', '>=']);

/** String parts of a ColumnRef's `fields`, or null if it is not a plain column.
 *  (transform.ts's private helper, reimplemented — that module exports only its
 *  offset/scanner/validation surface, and importing is the boundary here.) */
function columnParts(ref: unknown): string[] | null {
  const cr = node(node(ref)?.['ColumnRef']);
  if (!cr) return null;
  const fields = cr['fields'];
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 3) return null;
  const parts: string[] = [];
  for (const f of fields) {
    const s = node(node(f)?.['String'])?.['sval'];
    if (typeof s !== 'string') return null; // A_Star and friends
    parts.push(s);
  }
  return parts;
}

/** Relation names visible in the statement's own FROM, for resolving a column. */
function fromRelations(sel: Node): Array<{ parts: string[]; alias: string | null }> {
  const from = sel['fromClause'];
  if (!Array.isArray(from)) return [];
  const out: Array<{ parts: string[]; alias: string | null }> = [];
  const visit = (v: unknown): void => {
    const rv = node(node(v)?.['RangeVar']);
    if (rv) {
      const parts = [rv['schemaname'], rv['relname']].filter((x) => typeof x === 'string') as string[];
      out.push({ parts, alias: (node(rv['alias'])?.['aliasname'] as string) ?? null });
      return;
    }
    const je = node(node(v)?.['JoinExpr']);
    if (je) {
      visit(je['larg']);
      visit(je['rarg']);
    }
  };
  for (const f of from) visit(f);
  return out;
}

/**
 * Resolve a column reference to the base relation pg_stats will be asked
 * about. Refuses when an unqualified name could bind to more than one relation
 * — guessing here would sweep the wrong table's statistics.
 */
function resolveColumn(
  parts: string[],
  sel: Node,
): { relation: string[]; column: string } | { blocked: string } {
  const rels = fromRelations(sel);
  if (parts.length >= 2) {
    const qualifier = parts.at(-2)!;
    const match = rels.find((r) => (r.alias ?? r.parts.at(-1)) === qualifier);
    if (!match) return { blocked: `\`${qualifier}\` does not name a table in this query's FROM clause` };
    return { relation: match.parts, column: parts.at(-1)! };
  }
  if (rels.length !== 1) {
    return {
      blocked:
        `\`${parts[0]}\` is unqualified and this query reads ${rels.length} tables — ` +
        'qualify it and run the analysis again',
    };
  }
  return { relation: rels[0].parts, column: parts[0] };
}

/** Operator sval from an A_Expr `name` array. */
const operatorSval = (name: unknown): string | null => {
  if (!Array.isArray(name) || name.length === 0) return null;
  const s = node(node(name[name.length - 1])?.['String'])?.['sval'];
  return typeof s === 'string' ? s : null;
};

/** Does a $n parameter appear anywhere in the tree? */
export function hasParamRef(tree: unknown): boolean {
  if (Array.isArray(tree)) return tree.some(hasParamRef);
  const n = node(tree);
  if (!n) return false;
  for (const [key, v] of Object.entries(n)) {
    if (key === 'ParamRef') return true;
    if (hasParamRef(v)) return true;
  }
  return false;
}

/** The display operator for a comparison node, e.g. 'IN' rather than '='. */
function displayOperator(kind: unknown, sval: string | null): string | null {
  switch (kind) {
    case 'AEXPR_IN':
      return sval === '<>' ? 'NOT IN' : 'IN';
    case 'AEXPR_LIKE':
      return sval === '!~~' ? 'NOT LIKE' : 'LIKE';
    case 'AEXPR_ILIKE':
      return sval === '!~~*' ? 'NOT ILIKE' : 'ILIKE';
    case 'AEXPR_BETWEEN':
    case 'AEXPR_NOT_BETWEEN':
      return 'BETWEEN';
    default:
      return sval;
  }
}

const COMPARISON_KINDS = new Set([
  'AEXPR_OP', 'AEXPR_LIKE', 'AEXPR_ILIKE', 'AEXPR_IN', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN',
]);

/**
 * Walk the top-level SELECT's WHERE clause and report every comparison that
 * touches a plain column — usable sites with coordinates, everything else with
 * the reason it was skipped. Same topScope discipline as transform.ts
 * generateCandidates: a SubLink's or nested SelectStmt's columns resolve
 * against a different FROM, so those scopes are reported, never resolved.
 * JOIN..ON constants and predicates under NOT are out of scope in v1, and say so.
 */
export function discoverPredicates(sql: string, tree: unknown): DiscoveredPredicate[] {
  const out: DiscoveredPredicate[] = [];
  const stmts = (node(tree)?.['stmts'] as unknown[]) ?? [];
  const sel = node(node(node(stmts[0])?.['stmt'])?.['SelectStmt']);
  if (!sel || !sel['whereClause']) return out;

  const buf = Buffer.from(sql, 'utf8');

  const literalOf = (constNode: Node): { text: string; span: { start: number; end: number } } | null => {
    const loc = constNode['location'];
    if (typeof loc !== 'number' || loc < 0) return null;
    const end = literalEnd(buf, loc);
    if (end <= loc) return null;
    return { text: buf.subarray(loc, end).toString('utf8'), span: { start: loc, end } };
  };

  const record = (expr: Node, topScope: boolean, underNot: boolean): void => {
    const kind = expr['kind'];
    const sval = operatorSval(expr['name']);
    const op = displayOperator(kind, sval);
    const lParts = columnParts(expr['lexpr']);
    const rParts = columnParts(expr['rexpr']);
    const lConst = node(node(expr['lexpr'])?.['A_Const']);
    const rConst = node(node(expr['rexpr'])?.['A_Const']);
    // Expression-to-expression comparisons are not predicate-on-constant
    // shaped at all; everything else is reported, usable or not.
    if (!lParts && !rParts && !lConst && !rConst) return;
    const colParts = lParts ?? rParts;
    const constNode = lParts ? rConst : rParts ? lConst : (rConst ?? lConst);
    const literal = constNode ? literalOf(constNode) : null;
    const location = typeof expr['location'] === 'number' ? (expr['location'] as number) : -1;

    const candidate: PredicateCandidate = {
      column: colParts?.join('.') ?? null,
      operator: op,
      value: literal?.text ?? null,
      location,
      chosen: false,
      skipped: null,
    };
    const skip = (reason: string): void => {
      candidate.skipped = reason;
      out.push({ candidate, site: null });
    };

    if (!topScope) {
      return skip(
        'sits inside a nested subquery — its columns resolve against that subquery’s FROM, ' +
          'so the sweep skips it (analyse the subquery on its own)',
      );
    }
    if (underNot) {
      return skip(
        'sits under NOT, which inverts what the constant selects — sweeping it as written ' +
          'would mislabel the selectivities (out of scope in v1)',
      );
    }
    if (lParts && rParts) {
      return skip('compares two columns — there is no constant to vary');
    }
    if (!colParts) {
      return skip(
        'compares an expression, not a plain column — `pg_stats` describes bare columns, ' +
          'so a wrapped or computed column has no statistics to sweep',
      );
    }
    if (!constNode) {
      return skip('the compared value is an expression, not a plain literal — only a literal can be replaced with statistics values');
    }
    if (constNode['isnull'] === true) {
      return skip('compares against NULL, which no operator here ever matches — there is no selectivity to sweep');
    }
    if (kind !== 'AEXPR_OP' || !sval || !SWEEPABLE_OPS.has(sval)) {
      return skip(`\`${op ?? '?'}\` is not a sweepable comparison — only = < <= > >= read a histogram position or an MCV frequency`);
    }
    if (constNode['boolval'] !== undefined) {
      return skip('a boolean constant has only two values — a sweep needs a spectrum to walk');
    }
    if (!literal) {
      return skip('the parser reported no usable position for the literal');
    }
    const resolved = resolveColumn(colParts, sel);
    if ('blocked' in resolved) return skip(resolved.blocked);

    out.push({
      candidate,
      site: {
        location,
        column: resolved.column,
        relation: resolved.relation,
        relationKey: resolved.relation.map(quoteIdent).join('.'),
        operator: sval,
        literalText: literal.text,
        literalByteSpan: literal.span,
        charSpan: {
          start: byteToCharIndex(sql, literal.span.start),
          end: byteToCharIndex(sql, literal.span.end),
        },
      },
    });
  };

  const visit = (value: unknown, topScope: boolean, underNot: boolean): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v, topScope, underNot);
      return;
    }
    const n = node(value);
    if (!n) return;
    for (const [key, v] of Object.entries(n)) {
      const child = node(v);
      if (child) {
        if (key === 'A_Expr' && COMPARISON_KINDS.has(child['kind'] as string)) {
          record(child, topScope, underNot);
        }
        const nextTop = topScope && key !== 'SubLink' && key !== 'SelectStmt';
        const nextNot = underNot || (key === 'BoolExpr' && child['boolop'] === 'NOT_EXPR');
        visit(v, nextTop, nextNot);
      } else {
        visit(v, topScope, underNot);
      }
    }
  };

  visit(sel['whereClause'], true, false);
  return out;
}

// ── stats probe ──────────────────────────────────────────────────────────────

export interface StatsRow {
  rel: string;
  col: string;
  rel_exists: boolean;
  relkind: string | null;
  reltuples: number | null;
  inherited: boolean | null;
  null_frac: number | null;
  n_distinct: number | null;
  most_common_vals: unknown;
  most_common_freqs: unknown;
  histogram_bounds: unknown;
}

/**
 * One statement reading pg_class and pg_stats for every site at once — the
 * unnest idiom from buildCatalogProbe. `to_regclass` resolves through the
 * session's search_path, the same resolution the query gets, which is why the
 * orchestrator runs this in the SAME session as the EXPLAINs. The anyarray
 * columns go through `::text::text[]`: array output quotes awkward values and
 * array input unquotes them, so element text is exact.
 */
export function buildStatsProbe(sites: PredicateSite[]): { text: string; values: [string[], string[]] } {
  const seen = new Set<string>();
  const rels: string[] = [];
  const cols: string[] = [];
  for (const site of sites) {
    const key = `${site.relationKey} ${site.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rels.push(site.relationKey);
    cols.push(site.column);
  }
  return {
    text: `
      SELECT c.rel, c.col,
             t.oid IS NOT NULL                    AS rel_exists,
             t.relkind::text                      AS relkind,
             t.reltuples::float8                  AS reltuples,
             s.inherited                          AS inherited,
             s.null_frac::float8                  AS null_frac,
             s.n_distinct::float8                 AS n_distinct,
             s.most_common_vals::text::text[]     AS most_common_vals,
             s.most_common_freqs::float8[]        AS most_common_freqs,
             s.histogram_bounds::text::text[]     AS histogram_bounds
      FROM unnest($1::text[], $2::text[]) AS c(rel, col)
      LEFT JOIN pg_class t     ON t.oid = to_regclass(c.rel)
      LEFT JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_stats s     ON s.schemaname = n.nspname AND s.tablename = t.relname AND s.attname = c.col
      ORDER BY c.rel, c.col, s.inherited ASC NULLS LAST
    `,
    values: [rels, cols],
  };
}

/**
 * Parse a Postgres array literal (`{a,b,"c,d"}`) into its element texts.
 *
 * The driver normally does this for text[]; this is the defensive path, and
 * the reference for what "exact element text" means: quoted elements unescape
 * `\"` and `\\`, unquoted elements are verbatim, and an unquoted NULL is the
 * SQL null (a value that *spells* NULL comes back quoted). pg_stats value
 * arrays do not contain nulls, but the parser refuses to corrupt one into the
 * string 'NULL' if it ever meets it.
 */
export function parseArrayLiteral(text: string): (string | null)[] {
  const out: (string | null)[] = [];
  const s = text.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return out;
  const end = s.length - 1;
  let i = 1;
  let cur = '';
  let sawQuote = false;
  let inQuotes = false;
  const push = (): void => {
    if (!sawQuote && cur.length === 0) return; // `{}` — the empty array
    out.push(!sawQuote && /^null$/i.test(cur) ? null : cur);
    cur = '';
    sawQuote = false;
  };
  while (i < end) {
    const c = s[i];
    if (inQuotes) {
      if (c === '\\') {
        cur += s[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawQuote = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      push();
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  push();
  return out;
}

/** Coerce a probed anyarray column to element texts, whichever form it arrived in. */
export function toTextArray(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(String);
  if (typeof v === 'string') return parseArrayLiteral(v).filter((x): x is string => x !== null);
  return null;
}

function toNumberArray(v: unknown): number[] | null {
  const texts = toTextArray(v);
  if (!texts) return null;
  const nums = texts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

const nameOf = (site: PredicateSite): string => `${site.relation.join('.')}.${site.column}`;

function describeNDistinct(nd: number | null): string {
  if (nd === null) return 'unknown';
  if (nd === -1) return '≈ row count';
  if (nd < 0) return `≈ ${Math.round(-nd * 100)}% of the row count`;
  return `= ${nd}`;
}

/**
 * Turn probe rows into per-site verdicts with citable evidence.
 *
 * pg_stats can hold two rows per column (inherited true/false; partitioned
 * parents have only true): the probe orders inherited ASC NULLS LAST, and the
 * first row *with* statistics wins — plain tables get inherited=false,
 * partitioned parents fall back to inherited=true.
 */
export function interpretStats(sites: PredicateSite[], rows: StatsRow[]): SiteStats[] {
  const byKey = new Map<string, StatsRow[]>();
  for (const r of rows) {
    const key = `${r.rel} ${r.col}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  return sites.map((site) => {
    const name = nameOf(site);
    const group = byKey.get(`${site.relationKey} ${site.column}`) ?? [];
    const withStats = group.find((r) => r.inherited !== null && r.inherited !== undefined);
    const any = withStats ?? group[0];
    const reltuples = Math.max(0, any?.reltuples ?? 0);

    const none = (evidence: string): SiteStats => ({
      reltuples,
      nullFrac: withStats?.null_frac ?? null,
      nDistinct: withStats?.n_distinct ?? null,
      mcv: null,
      mcvFreqs: null,
      histogram: null,
      basis: null,
      evidence,
    });

    if (!any || !any.rel_exists) {
      return none(`\`${site.relation.join('.')}\` does not resolve in this database's search_path`);
    }
    if (!withStats) {
      return none(
        `\`pg_stats\` has no row for \`${name}\` — the table may never have been ANALYZEd ` +
          '(or the column is not readable by this role)',
      );
    }

    const mcv = toTextArray(withStats.most_common_vals);
    const mcvFreqs = toNumberArray(withStats.most_common_freqs);
    const histogram = toTextArray(withStats.histogram_bounds);
    const base: Omit<SiteStats, 'basis' | 'evidence'> = {
      reltuples,
      nullFrac: withStats.null_frac ?? null,
      nDistinct: withStats.n_distinct ?? null,
      mcv,
      mcvFreqs,
      histogram,
    };

    if (site.operator === '=') {
      if (!mcv || mcv.length === 0) {
        return {
          ...base,
          basis: null,
          evidence:
            `\`${name}\` has no most_common_vals in \`pg_stats\` — the planner treats every value as equally ` +
            `selective (n_distinct ${describeNDistinct(base.nDistinct)}), so varying an equality constant cannot flip the plan`,
        };
      }
      return {
        ...base,
        basis: 'mcv',
        evidence:
          `\`${name}\` keeps ${mcv.length} most_common_vals in \`pg_stats\` — the sampled frequencies ` +
          'the planner actually uses to estimate an equality',
      };
    }

    // Range operator: < <= > >= read the histogram.
    if (!histogram || histogram.length === 0) {
      return {
        ...base,
        basis: null,
        evidence:
          `\`${name}\` has no histogram in \`pg_stats\` — every sampled value is in most_common_vals, ` +
          'so there is no rarer range to sweep',
      };
    }
    if (histogram.length < 2) {
      return {
        ...base,
        basis: null,
        evidence: `the histogram for \`${name}\` is too small to sweep — only ${histogram.length} distinct bound`,
      };
    }
    return {
      ...base,
      basis: 'histogram',
      evidence:
        `\`${name}\` has a ${histogram.length}-bound histogram in \`pg_stats\` — the planner's own picture ` +
        `of the column, splitting its non-MCV rows into ${histogram.length - 1} equal-frequency buckets`,
    };
  });
}

// ── choice ───────────────────────────────────────────────────────────────────

/**
 * Among usable sites, pick the one on the relation with the LARGEST
 * pg_class.reltuples (tie-break: earliest location).
 *
 * Chosen over "the top-cost scan" deliberately: reltuples is decidable from
 * the same catalog probe, deterministic, and citable in one sentence — and it
 * does not depend on a plan the sweep itself is about to change. The response
 * carries every candidate with coordinates, so a caller who disagrees can pin
 * a different site by location without an API change.
 */
export function chooseSite(
  entries: Array<{ site: PredicateSite; stats: SiteStats }>,
): { index: number; why: string } {
  let best = 0;
  for (let i = 1; i < entries.length; i += 1) {
    const b = entries[best];
    const c = entries[i];
    if (
      c.stats.reltuples > b.stats.reltuples ||
      (c.stats.reltuples === b.stats.reltuples && c.site.location < b.site.location)
    ) {
      best = i;
    }
  }
  const chosen = entries[best];
  const rel = chosen.site.relation.join('.');
  const why =
    entries.length === 1
      ? `the only comparison whose column has usable statistics — \`${rel}\` holds ~${formatRows(chosen.stats.reltuples)} rows (\`pg_class.reltuples\`)`
      : `chosen because \`${rel}\` holds ~${formatRows(chosen.stats.reltuples)} rows (\`pg_class.reltuples\`) — ` +
        'the predicate on the largest table is where selectivity moves the most rows';
  return { index: best, why };
}

// ── variants ─────────────────────────────────────────────────────────────────

/** Single-quoted SQL literal with '' doubling — coerced by the column's type
 *  input function in the comparison, exactly as the original literal was. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Splice `replacement` over [start,end) in the byte domain (the café trap is real here too). */
function spliceBytes(sql: string, span: { start: number; end: number }, replacement: string): string {
  const buf = Buffer.from(sql, 'utf8');
  return Buffer.concat([
    buf.subarray(0, span.start),
    Buffer.from(replacement, 'utf8'),
    buf.subarray(span.end),
  ]).toString('utf8');
}

/**
 * Confirm a variant changed exactly the one constant and nothing else.
 *
 * Reuses transform.ts validateSplice's containment machinery: reparse the
 * variant, strip locations from both trees, and require every divergence to
 * sit inside one region equal to the probe-parsed literal. `SELECT 1 WHERE
 * <literal>` is grammatically valid for any literal (typing happens later),
 * so the boolean-expression probe doubles as a constant probe. A variant that
 * is byte-identical to the original — the stats value equals the constant as
 * written — is trivially valid: same text, same tree, same plan.
 */
export function validateConstSplice(originalSql: string, variantSql: string, literal: string): string | null {
  if (variantSql === originalSql) return null;
  return validateSplice(originalSql, variantSql, literal);
}

const dedupe = (entries: Array<{ label: string; value: string; frequency: number | null }>) => {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.value)) return false;
    seen.add(e.value);
    return true;
  });
};

/**
 * Build the sweep variants for one site from its statistics.
 *
 * RANGE (< <= > >=): histogram bounds at positions round((n-1)·0.10/0.50/0.90),
 * labelled p10/p50/p90 — the bounds array is already sorted, so the sweep is
 * ordered by histogram position without parsing a single value. EQUALITY (=):
 * the first MCV ('most common'), the last MCV ('least common MCV'), and a
 * middle histogram bound ('outside the MCV list') when a histogram exists —
 * histogram bounds are sampled values excluded from the MCV list, so that one
 * is a genuinely rarer value. When every distinct value is an MCV there is no
 * histogram, and that variant is skipped with its sentence rather than faked.
 */
export function buildVariants(sql: string, site: PredicateSite, stats: SiteStats): VariantBuild {
  const notes: string[] = [];
  let picks: Array<{ label: string; value: string; frequency: number | null }> = [];

  if (site.operator === '=') {
    const mcv = stats.mcv ?? [];
    const freqs = stats.mcvFreqs ?? [];
    if (mcv.length === 0) return { ok: false, refusal: stats.evidence };
    picks.push({ label: 'most common', value: mcv[0], frequency: freqs[0] ?? null });
    if (mcv.length > 1) {
      picks.push({ label: 'least common MCV', value: mcv[mcv.length - 1], frequency: freqs[mcv.length - 1] ?? null });
    }
    const hist = stats.histogram ?? [];
    if (hist.length > 0) {
      picks.push({ label: 'outside the MCV list', value: hist[Math.round((hist.length - 1) / 2)], frequency: null });
    } else {
      notes.push(
        `every value \`${nameOf(site)}\` holds is in most_common_vals — no rarer value exists to test`,
      );
    }
  } else {
    const hist = stats.histogram ?? [];
    if (hist.length === 0) return { ok: false, refusal: stats.evidence };
    picks = [
      { label: 'p10', value: hist[Math.round((hist.length - 1) * 0.1)], frequency: null },
      { label: 'p50', value: hist[Math.round((hist.length - 1) * 0.5)], frequency: null },
      { label: 'p90', value: hist[Math.round((hist.length - 1) * 0.9)], frequency: null },
    ];
  }

  picks = dedupe(picks);
  if (picks.length < 2) {
    return {
      ok: false,
      refusal:
        site.operator === '='
          ? `\`pg_stats\` offers only ${picks.length} distinct value for \`${nameOf(site)}\` — a sweep needs at least two points to show a boundary`
          : `the histogram for \`${nameOf(site)}\` is too small to sweep — only ${picks.length} distinct bound${picks.length === 1 ? '' : 's'} at the p10/p50/p90 positions`,
    };
  }

  const variants: VariantSpec[] = [];
  for (const pick of picks) {
    const literal = quoteLiteral(pick.value);
    const spliced = spliceBytes(sql, site.literalByteSpan, literal);
    const problem = validateConstSplice(sql, spliced, literal);
    if (problem) {
      // Withheld, not shipped: an invalid splice is an agent bug, and a wrong
      // variant presented as evidence is the worst failure available here.
      notes.push(`the ${pick.label} variant was withheld: ${problem}`);
      continue;
    }
    variants.push({ label: pick.label, value: pick.value, literal, sql: spliced, frequency: pick.frequency });
  }
  if (variants.length < 2) {
    return { ok: false, refusal: 'variant generation failed reparse validation — this is an agent bug, not a property of your query' };
  }
  return { ok: true, variants, notes };
}

// ── signatures, flips, narrative ─────────────────────────────────────────────

const JOIN_OPERATORS = new Set(['Nested Loop', 'Hash Join', 'Merge Join']);

/**
 * The plan's access identity: every scan, labelled exactly as history.ts
 * accessMethodsOf labels them ("Index Scan on orders via orders_pkey"), plus
 * the join operator node types — the same identity fields core diff.ts
 * signature() keys on. plan.nodes is depth-first from the root, so the list is
 * pre-ordered and two plans compare positionally.
 */
export function accessSignature(plan: QueryPlan): string[] {
  return plan.nodes
    .filter((n) => (n.nodeType.endsWith('Scan') && (n.relation || n.indexName)) || JOIN_OPERATORS.has(n.nodeType))
    .map((n) =>
      JOIN_OPERATORS.has(n.nodeType)
        ? n.nodeType
        : `${n.nodeType}${n.relation ? ` on ${n.relation}` : ''}${n.indexName ? ` via ${n.indexName}` : ''}`,
    );
}

const sameSignature = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const shortValue = (v: string): string => (v.length > 12 ? `${v.slice(0, 12)}…` : v);

/** The signature entries present in `a` but not `b`, for the flip headline. */
function signatureDelta(a: string[], b: string[]): string {
  const other = new Set(b);
  const delta = a.filter((x) => !other.has(x));
  return (delta.length > 0 ? delta : a).join(' + ');
}

/**
 * Every adjacent ordered pair whose signatures differ is a flip boundary.
 * The headline is a bracket between the two points, never an interpolated
 * crossing — the exact crossing constant is not knowable from two EXPLAINs,
 * and a guessed number wearing precision would be worse than the honest range.
 */
export function findFlips(points: FlipPoint[], site: Pick<PredicateSite, 'column' | 'operator'>): FlipBoundary[] {
  const out: FlipBoundary[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (sameSignature(from.signature, to.signature)) continue;
    const headline =
      `Between \`${site.column} ${site.operator} ${shortValue(from.value)}\` (${from.label}, ~${formatRows(from.estimatedRows)} rows estimated) ` +
      `and \`${site.column} ${site.operator} ${shortValue(to.value)}\` (${to.label}, ~${formatRows(to.estimatedRows)} rows) the plan flips: ` +
      `${signatureDelta(from.signature, to.signature)} → ${signatureDelta(to.signature, from.signature)}. ` +
      `The planner's cost estimates cross between these points (${from.totalCost.toFixed(0)} vs ${to.totalCost.toFixed(0)}) — estimates, not measurements.`;
    out.push({
      fromLabel: from.label,
      toLabel: to.label,
      fromValue: from.value,
      toValue: to.value,
      before: from.signature,
      after: to.signature,
      costFrom: from.totalCost,
      costTo: to.totalCost,
      headline,
    });
  }
  return out;
}

/**
 * The teaching paragraph. Selectivity claims are read from the planner's own
 * per-variant row estimates, never computed here — the narrator reports what
 * EXPLAIN said, in the template voice, so it cannot claim more than the
 * planner did.
 */
export function composeNarrative(args: {
  site: PredicateSite;
  stats: SiteStats;
  evidence: string;
  points: FlipPoint[];
  flips: FlipBoundary[];
  baselineMatchesLabel: string | null;
  notes: string[];
}): string {
  const { site, stats, evidence, points, flips, baselineMatchesLabel, notes } = args;
  const col = site.column;
  const op = site.operator;
  const first = points[0];
  const last = points[points.length - 1];
  const parts: string[] = [`${evidence}.`];

  parts.push(
    `At \`${col} ${op} ${shortValue(first.value)}\` (${first.label}) the planner expects ` +
      `~${formatRows(first.estimatedRows)} of ~${formatRows(stats.reltuples)} rows and plans ` +
      `${first.signature.join(' + ') || 'no scan at all'}; at \`${col} ${op} ${shortValue(last.value)}\` (${last.label}) ` +
      `it expects ~${formatRows(last.estimatedRows)} and plans ${last.signature.join(' + ') || 'no scan at all'}.`,
  );

  if (flips.length > 0) {
    parts.push(
      'The flip is the cost model working: the same SQL is a different problem at different selectivities, ' +
        'and the boundary above is where the estimates cross.',
    );
  } else {
    const rowsSpread = points.map((p) => p.estimatedRows);
    const lo = Math.min(...rowsSpread);
    const hi = Math.max(...rowsSpread);
    parts.push(
      `Every point planned the same way — ${first.signature.join(' + ')} at each constant the statistics offer. ` +
        `The estimated rows move (${formatRows(lo)} to ${formatRows(hi)}) but never enough to make another access path cheaper.`,
    );
  }

  parts.push(
    baselineMatchesLabel
      ? `As written, the query plans with the same shape as the ${baselineMatchesLabel} point. ` +
          'The as-written constant is reported beside the sweep rather than placed inside its ordering — ' +
          'ranking it among typed histogram bounds would mean parsing values by type, and a guess there would be a lie wearing precision.'
      : 'As written, the query plans with a shape none of the sweep points produced — worth a look at the baseline plan.',
  );

  for (const note of notes) parts.push(`${note.charAt(0).toUpperCase()}${note.slice(1)}.`);

  if (site.operator === '=' && stats.mcvFreqs && stats.mcvFreqs.length > 0) {
    const mostCommon = points.find((p) => p.label === 'most common');
    if (mostCommon) {
      parts.push(
        `\`${shortValue(mostCommon.value)}\` covers ${formatPercent(stats.mcvFreqs[0])} of the sampled rows on its own — ` +
          'frequency, not the value itself, is what the planner prices.',
      );
    }
  }

  return parts.join(' ');
}
