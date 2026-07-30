/**
 * The SQL rewrite advisor — REQUIREMENTS.md F4.
 *
 * Analyses the *query text*, not the plan, using libpg-query — the actual
 * Postgres parser compiled to a library. That matters: the anti-patterns worth
 * detecting are structural (a function wrapping a column, a subquery's null
 * semantics), and regex over SQL cannot see structure. Hand-rolling a SQL
 * parser is the trap this avoids.
 *
 * Lives in the agent rather than core for two reasons: core stays pure and
 * browser-safe (the UI imports it directly, and a native/wasm parser has no
 * business in a browser bundle), and the parser is Postgres-specific while core
 * is deliberately engine-neutral.
 *
 * Findings here describe *structure*, so they hold regardless of data. Where a
 * rewrite would change results rather than just speed — `NOT IN` being the
 * classic — that is reported as a semantic change, never buried.
 */

import { loadModule, parseSync } from 'libpg-query';

import { byteToCharIndex, generateCandidates, type CandidateRewrite } from './transform.ts';

export type { CandidateRewrite } from './transform.ts';

export type RewriteKind =
  | 'function-on-column'
  | 'not-in-subquery'
  | 'not-in-list'
  | 'select-star'
  | 'large-offset'
  | 'leading-wildcard'
  | 'or-across-columns'
  | 'correlated-subquery-in-select'
  | 'distinct-with-join'
  | 'count-star-subquery';

export interface RewriteFinding {
  kind: RewriteKind;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  /** What was found, structurally. */
  detail: string;
  /** What to do instead. */
  suggestion: string;
  /**
   * Set when applying the rewrite changes *results*, not just performance.
   * This is the field that stops the advisor being dangerous — a rewrite that
   * silently changes behaviour is worse than no advice at all.
   */
  semanticChange: string | null;
  /** Byte offset into the original SQL, when the parser reported one. */
  location: number | null;
  /** The fragment of SQL this is about. */
  snippet: string | null;
  /**
   * The rewritten statement, generated and structurally validated, when this
   * finding's kind supports Tier A and the query's shape is within scope. The
   * preconditions it carries are schema facts to be established at prove time,
   * never assumed — an unproven candidate is a draft, not advice.
   */
  candidate: CandidateRewrite | null;
  /** Why no candidate was generated, when the kind supports one. */
  candidateBlocked: string | null;
}

// ── Parser bootstrap ─────────────────────────────────────────────────────────

let ready: Promise<void> | null = null;

/** libpg-query needs its wasm module loaded once before parseSync works. */
export async function initParser(): Promise<void> {
  if (!ready) ready = loadModule();
  await ready;
}

export class SqlParseError extends Error {
  readonly cursorPosition: number | null;
  constructor(message: string, cursorPosition: number | null) {
    super(message);
    this.name = 'SqlParseError';
    this.cursorPosition = cursorPosition;
  }
}

// ── AST helpers ──────────────────────────────────────────────────────────────

type Node = Record<string, any>;

/**
 * Walk every node in the parse tree.
 *
 * Postgres wraps each node as a single-key object — `{A_Expr: {...}}` — so the
 * key names the node type. The visitor is called with that type for every
 * object encountered.
 */
function walk(node: unknown, visit: (type: string, value: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Node)) {
    if (value && typeof value === 'object') {
      visit(key, value as Node);
      walk(value, visit);
    }
  }
}

/** True when this subtree contains a reference to a table column. */
function containsColumnRef(node: unknown): boolean {
  let found = false;
  walk(node, (type) => {
    if (type === 'ColumnRef') found = true;
  });
  return found;
}

/** Column names referenced anywhere in a subtree. */
function columnNames(node: unknown): string[] {
  const names: string[] = [];
  walk(node, (type, value) => {
    if (type !== 'ColumnRef') return;
    const fields = value['fields'];
    if (!Array.isArray(fields)) return;
    const parts = fields
      .map((f: Node) => f?.['String']?.['sval'])
      .filter((s: unknown): s is string => typeof s === 'string');
    if (parts.length > 0) names.push(parts.join('.'));
  });
  return names;
}

/** Operator name from an A_Expr / SubLink `name` array. */
function operatorName(name: unknown): string | null {
  if (!Array.isArray(name)) return null;
  const first = name[name.length - 1] as Node | undefined;
  const sval = first?.['String']?.['sval'];
  return typeof sval === 'string' ? sval : null;
}

function constString(node: unknown): string | null {
  const c = (node as Node)?.['A_Const'];
  const sval = c?.['sval']?.['sval'];
  return typeof sval === 'string' ? sval : null;
}

function constInt(node: unknown): number | null {
  const c = (node as Node)?.['A_Const'];
  const ival = c?.['ival']?.['ival'];
  if (typeof ival === 'number') return ival;
  // Postgres omits `ival` entirely for the integer zero.
  if (c?.['ival'] && typeof c['ival'] === 'object') return 0;
  return null;
}

/**
 * A readable fragment of the original SQL around a reported offset.
 *
 * Postgres reports the location of the *operand*, not the clause, so a raw
 * slice starting there reads as "100000 LIMIT 20" with the OFFSET it belongs to
 * cut off. Backing up to a word boundary first restores the keyword that makes
 * the fragment recognisable.
 */
function snippetAt(sql: string, byteLocation: number | null, span = 60, lead = 16): string | null {
  if (byteLocation === null || byteLocation < 0) return null;
  // The parser reports byte offsets; everything below indexes a JS string. On
  // any non-ASCII query those are different numbers, and slicing with the wrong
  // one shifts the snippet off the token it is supposed to show.
  const location = byteToCharIndex(sql, byteLocation);
  if (location >= sql.length) return null;

  let start = Math.max(0, location - lead);
  if (start > 0) {
    // Snap forward to a whitespace boundary so we never start mid-token.
    const boundary = sql.slice(start, location).search(/\s\S/);
    start = boundary === -1 ? location : start + boundary + 1;
  }

  const end = Math.min(sql.length, location + span);
  const text = sql.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${end < sql.length ? '…' : ''}`;
}

/**
 * Functions that read as wrapping a column but do not defeat an index, because
 * they take no column argument at all (`now()`) or are handled elsewhere.
 * Deliberately tiny — suppressing a real warning is the costlier mistake.
 */
const NON_WRAPPING_FUNCTIONS = new Set(['now', 'current_date', 'current_timestamp', 'random']);

// ── The rules ────────────────────────────────────────────────────────────────

/**
 * Analyse a SQL statement for structural anti-patterns.
 *
 * Requires initParser() to have resolved.
 */
export function analyzeRewrites(sql: string): RewriteFinding[] {
  let tree: Node;
  try {
    tree = parseSync(sql) as Node;
  } catch (err) {
    const e = err as { message?: string; cursorPosition?: number };
    throw new SqlParseError(e?.message ?? String(err), e?.cursorPosition ?? null);
  }

  const findings: RewriteFinding[] = [];
  const seen = new Set<string>();
  const candidates = new Map<string, ReturnType<typeof generateCandidates>[number]['result']>();

  const push = (finding: Omit<RewriteFinding, 'candidate' | 'candidateBlocked'>): void => {
    // One finding per kind per location; the same pattern often appears in
    // several branches of one tree.
    const key = `${finding.kind}:${finding.location ?? ''}:${finding.snippet ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...finding, candidate: null, candidateBlocked: null });
  };

  for (const stmtWrapper of (tree['stmts'] as Node[] | undefined) ?? []) {
    const stmt = stmtWrapper?.['stmt'];
    if (!stmt) continue;

    // Generate Tier A candidates for this statement, keyed the way findings
    // are located, so the two pair up below. Generation failing must never
    // take the advisor down with it — the prose advice stands on its own.
    try {
      for (const site of generateCandidates(sql, stmt)) {
        candidates.set(`${site.kind}:${site.location ?? ''}`, site.result);
      }
    } catch {
      // Findings keep candidate: null, which renders as advice-only.
    }

    checkSelectStar(stmt, sql, push);
    checkLargeOffset(stmt, sql, push);
    checkCorrelatedSubqueryInSelect(stmt, sql, push);

    walk(stmt, (type, value) => {
      if (type === 'A_Expr') checkAExpr(value, sql, push);
      if (type === 'SubLink') checkSubLink(value, sql, push);
      if (type === 'BoolExpr') checkBoolExpr(value, sql, push);
    });
  }

  for (const f of findings) {
    const site = candidates.get(`${f.kind}:${f.location ?? ''}`);
    if (!site) continue;
    if (site.ok) f.candidate = site.candidate;
    else f.candidateBlocked = site.blocked;
  }

  return findings;
}

type Push = (finding: Omit<RewriteFinding, 'candidate' | 'candidateBlocked'>) => void;

/** `WHERE date(created_at) = …` — a b-tree on created_at cannot serve this. */
function checkAExpr(expr: Node, sql: string, push: Push): void {
  const op = operatorName(expr['name']);
  if (!op) return;

  for (const side of ['lexpr', 'rexpr'] as const) {
    const operand = expr[side];
    const call = (operand as Node)?.['FuncCall'];
    if (!call) continue;

    const fname = operatorName(call['funcname']);
    if (!fname || NON_WRAPPING_FUNCTIONS.has(fname)) continue;
    if (!containsColumnRef(call['args'])) continue;

    const columns = columnNames(call['args']);
    const column = columns[0] ?? 'the column';
    const location = typeof call['location'] === 'number' ? call['location'] : null;

    push({
      kind: 'function-on-column',
      severity: 'critical',
      title: `${fname}() wraps ${column}, so no plain index on it can be used`,
      detail:
        `The predicate applies ${fname}() to ${column} before comparing. Postgres can only use a b-tree index on ` +
        `${column} itself, not on the result of a function over it, so this forces a scan of every row even when an index exists.`,
      suggestion:
        `Rewrite the predicate as a range over the raw column — for a date truncation that means ` +
        `${column} >= 'start' AND ${column} < 'end' — or build an expression index: ` +
        `CREATE INDEX ON <table> (${fname}(${column})).`,
      semanticChange: null,
      location,
      snippet: snippetAt(sql, location),
    });
  }

  checkLeadingWildcard(expr, op, sql, push);
  checkNotInList(expr, op, sql, push);
}

/** `col LIKE '%foo'` — a b-tree cannot bound a scan without a fixed prefix. */
function checkLeadingWildcard(expr: Node, op: string, sql: string, push: Push): void {
  if (op !== '~~' && op !== '~~*') return;

  const pattern = constString(expr['rexpr']);
  if (!pattern || !pattern.startsWith('%')) return;

  const column = columnNames(expr['lexpr'])[0] ?? 'the column';
  const location = typeof expr['location'] === 'number' ? expr['location'] : null;

  push({
    kind: 'leading-wildcard',
    severity: 'warning',
    title: `LIKE '${pattern.length > 20 ? `${pattern.slice(0, 20)}…` : pattern}' on ${column} starts with a wildcard`,
    detail:
      'A b-tree index is ordered by the start of the value, so it can only narrow a search when the pattern has a fixed prefix. ' +
      'A leading % forces every row to be tested.',
    suggestion:
      `Use a trigram index for substring search: CREATE EXTENSION pg_trgm; CREATE INDEX ON <table> USING gin (${column} gin_trgm_ops). ` +
      'For real text search, a tsvector column with a GIN index is the better fit.',
    semanticChange: null,
    location,
    snippet: snippetAt(sql, location),
  });
}

/** `x NOT IN (1, 2, NULL)` — one NULL and the whole predicate returns no rows. */
function checkNotInList(expr: Node, op: string, sql: string, push: Push): void {
  if (expr['kind'] !== 'AEXPR_IN' || op !== '<>') return;

  const column = columnNames(expr['lexpr'])[0] ?? 'the column';
  const location = typeof expr['location'] === 'number' ? expr['location'] : null;

  push({
    kind: 'not-in-list',
    severity: 'info',
    title: `NOT IN on ${column} — check the list can never contain NULL`,
    detail:
      'NOT IN evaluates to NULL, not true, as soon as the list contains a NULL — so the whole predicate matches nothing. ' +
      'With a literal list this is only a risk if a NULL can appear there.',
    suggestion: 'If the list is ever built from data rather than literals, use NOT EXISTS instead.',
    semanticChange: null,
    location,
    snippet: snippetAt(sql, location),
  });
}

/**
 * `x <> ALL (SELECT …)` — the explicitly-spelled form of NOT IN.
 *
 * The far commoner `x NOT IN (SELECT …)` does NOT parse to this. Postgres
 * represents it as NOT wrapped around an ANY_SUBLINK, so it is caught in
 * checkBoolExpr instead — see the note there.
 */
function checkSubLink(link: Node, sql: string, push: Push): void {
  if (link['subLinkType'] !== 'ALL_SUBLINK' || operatorName(link['operName']) !== '<>') return;
  const location = typeof link['location'] === 'number' ? link['location'] : null;
  pushNotInSubquery(columnNames(link['testexpr'])[0] ?? 'the column', location, sql, push);
}

function pushNotInSubquery(column: string, location: number | null, sql: string, push: Push): void {
  push({
    kind: 'not-in-subquery',
    severity: 'critical',
    title: `NOT IN (SELECT …) on ${column} — correctness risk, and it blocks anti-join optimisation`,
    detail:
      'Two problems. Correctness: if the subquery returns even one NULL, NOT IN evaluates to NULL for every row and the ' +
      'query returns nothing at all — silently. Performance: Postgres cannot turn NOT IN into an anti-join, so it often ' +
      'falls back to a materialised subplan re-checked per row.',
    suggestion:
      'Rewrite as NOT EXISTS (SELECT 1 FROM … WHERE …), which the planner can execute as a proper anti-join.',
    semanticChange:
      'NOT EXISTS is not a drop-in equivalent. Where the subquery yields NULLs, NOT IN returns no rows and NOT EXISTS ' +
      'returns matching rows — so the rewrite can change your result set. That is usually the bug being fixed, but confirm ' +
      'the NULL case is what you intend before shipping it.',
    location,
    snippet: snippetAt(sql, location),
  });
}

/**
 * Boolean expressions: `NOT IN (SELECT …)`, and OR across different columns.
 *
 * The NOT IN case lives here because of how Postgres actually parses it —
 * `id NOT IN (SELECT …)` becomes BoolExpr{NOT_EXPR} wrapping
 * SubLink{ANY_SUBLINK}, i.e. "not (id = any (...))", rather than the
 * ALL_SUBLINK the SQL text suggests.
 */
function checkBoolExpr(expr: Node, sql: string, push: Push): void {
  if (expr['boolop'] === 'NOT_EXPR') {
    const args = expr['args'];
    if (!Array.isArray(args)) return;
    for (const arg of args) {
      const link = (arg as Node)?.['SubLink'];
      if (!link || link['subLinkType'] !== 'ANY_SUBLINK') continue;
      // An ANY_SUBLINK with a subselect is IN (SELECT …); wrapped in NOT it is
      // NOT IN (SELECT …). A bare ANY over an array is a different thing.
      if (!link['subselect']) continue;
      const location = typeof link['location'] === 'number' ? link['location'] : null;
      pushNotInSubquery(columnNames(link['testexpr'])[0] ?? 'the column', location, sql, push);
    }
    return;
  }

  if (expr['boolop'] !== 'OR_EXPR') return;

  const args = expr['args'];
  if (!Array.isArray(args) || args.length < 2) return;

  // Only interesting when the arms touch *different* columns; `a = 1 OR a = 2`
  // is just an IN list and Postgres handles it fine.
  const perArm = args.map((arg) => new Set(columnNames(arg)));
  const distinct = new Set<string>();
  for (const set of perArm) for (const name of set) distinct.add(name);
  if (distinct.size < 2) return;

  const armsAreDisjoint = perArm.every(
    (set, i) => [...set].every((name) => perArm.every((other, j) => i === j || !other.has(name))),
  );
  if (!armsAreDisjoint) return;

  const location = typeof expr['location'] === 'number' ? expr['location'] : null;

  push({
    kind: 'or-across-columns',
    severity: 'info',
    title: `OR spans different columns (${[...distinct].slice(0, 3).join(', ')})`,
    detail:
      'A single index cannot satisfy both sides of an OR across different columns. Postgres may manage a BitmapOr over two ' +
      'indexes, but it often falls back to a sequential scan instead.',
    suggestion:
      'If the plan shows a sequential scan here, try UNION ALL of per-arm queries — each arm can then use its own index. ' +
      'Guard each later arm with AND (earlier arm) IS NOT TRUE so the arms stay mutually exclusive.',
    semanticChange:
      'A bare UNION ALL returns a row once per arm it matches, where the OR returned it once. The IS NOT TRUE guards ' +
      'restore exactness — each row lands in exactly one arm, NULLs included — and a de-duplicating UNION is not a fix, ' +
      'since it would also collapse rows that were legitimately duplicated.',
    location,
    snippet: snippetAt(sql, location),
  });
}

/** `SELECT *` — blocks index-only scans and ships columns nobody reads. */
function checkSelectStar(stmt: Node, sql: string, push: Push): void {
  walk(stmt, (type, value) => {
    if (type !== 'ResTarget') return;
    const fields = value['val']?.['ColumnRef']?.['fields'];
    if (!Array.isArray(fields)) return;
    if (!fields.some((f: Node) => f?.['A_Star'] !== undefined)) return;

    const location = typeof value['location'] === 'number' ? value['location'] : null;
    push({
      kind: 'select-star',
      severity: 'info',
      title: 'SELECT * fetches every column',
      detail:
        'Every column is read and sent, including ones the application ignores. It also rules out an index-only scan, ' +
        'since no index can cover all columns — and it makes the query silently change shape when a column is added.',
      suggestion: 'List the columns you actually use. A narrow list can turn an index scan into an index-only scan.',
      semanticChange: null,
      location,
      snippet: snippetAt(sql, location, 30),
    });
  });
}

/** `OFFSET 50000` — the skipped rows are still produced, then discarded. */
function checkLargeOffset(stmt: Node, sql: string, push: Push): void {
  walk(stmt, (type, value) => {
    if (type !== 'SelectStmt') return;
    const offset = constInt(value['limitOffset']);
    if (offset === null || offset < 1000) return;

    const location = typeof (value['limitOffset'] as Node)?.['A_Const']?.['location'] === 'number'
      ? (value['limitOffset'] as Node)['A_Const']['location']
      : null;

    push({
      kind: 'large-offset',
      severity: 'warning',
      title: `OFFSET ${offset.toLocaleString('en-US')} discards rows it had to produce first`,
      detail:
        `Postgres has no way to skip ahead: it generates all ${offset.toLocaleString('en-US')} rows, throws them away, and ` +
        'then returns the page you asked for. Cost grows with the page number, so the last page of a listing is the slowest.',
      suggestion:
        'Use keyset pagination — remember the sort key of the last row and use WHERE (sort_key) > :last ORDER BY sort_key LIMIT n. ' +
        'Cost then stays flat regardless of depth.',
      semanticChange:
        'Keyset pagination cannot jump to an arbitrary page number, so it suits infinite scroll and "next" links rather than ' +
        'numbered page controls.',
      location,
      snippet: snippetAt(sql, location, 24),
    });
  });
}

/** A per-row subquery in the select list, where a join would do. */
function checkCorrelatedSubqueryInSelect(stmt: Node, sql: string, push: Push): void {
  const targetList = (stmt as Node)?.['SelectStmt']?.['targetList'];
  if (!Array.isArray(targetList)) return;

  for (const target of targetList) {
    const val = (target as Node)?.['ResTarget']?.['val'];
    const link = (val as Node)?.['SubLink'];
    if (!link || link['subLinkType'] !== 'EXPR_SUBLINK') continue;

    const location = typeof link['location'] === 'number' ? link['location'] : null;
    push({
      kind: 'correlated-subquery-in-select',
      severity: 'warning',
      title: 'Scalar subquery in the SELECT list runs once per output row',
      detail:
        'A subquery in the select list is evaluated for every row the outer query returns. At a thousand rows that is a ' +
        'thousand executions, which is the same shape as an N+1 query but hidden inside one statement.',
      suggestion:
        'Move it into the FROM clause as a LEFT JOIN LATERAL, or as a plain LEFT JOIN over a grouped subquery, so it is ' +
        'evaluated once as a set.',
      semanticChange:
        'A scalar subquery returns NULL when it matches nothing and errors when it matches more than one row. A LEFT JOIN ' +
        'preserves the NULL but silently multiplies outer rows when several match. A unique index over the join columns ' +
        'rules that out — which is what the generated rewrite requires as a precondition before anything runs.',
      location,
      snippet: snippetAt(sql, location),
    });
  }
}
