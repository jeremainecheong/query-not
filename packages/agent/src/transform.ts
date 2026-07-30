/**
 * Generating the optimised query.
 *
 * The rewrite advisor tells you what to do. This module writes it for you — for
 * three kinds where the result set is provably identical given a schema fact we
 * can check. Everything here is pure: no database, no connection. The schema
 * facts it depends on are *declared* as preconditions and established later, at
 * prove time, by `catalog.ts`.
 *
 * Two things make this safe rather than clever:
 *
 *   1. **Byte offsets.** libpg_query reports `location` as a UTF-8 byte offset,
 *      not a JS string index. For `… note = 'café' AND date(created_at) …` the
 *      parser says 41 where `String.indexOf` says 40. Splicing a JS string at a
 *      byte offset produces valid-but-different SQL, which is the worst failure
 *      available to a tool that claims proof. All arithmetic here is on Buffer.
 *
 *   2. **Validation by reparse.** After splicing we re-parse and compare the new
 *      tree against the old one with the expected subtree substituted in, with
 *      every `location` stripped. Exactly one node may differ, and it must equal
 *      what we meant to write. A scanner bug, an off-by-one, a broken operator
 *      precedence — each shows up as a structural mismatch, and the candidate is
 *      withheld rather than offered.
 *
 * Guards and preconditions are different layers and must not be confused:
 * a *guard* is decidable from the AST and refuses to generate at all (an outer
 * join anywhere in the statement, an ambiguous unqualified column). A
 * *precondition* is decidable only against the catalog and is checked before the
 * candidate is ever executed.
 */
import { parseSync } from 'libpg-query';

export type GeneratedRewriteKind = 'not-in-subquery' | 'not-in-list' | 'function-on-column';

/** A schema fact that must hold for the rewrite to preserve results. */
export type PreconditionSpec =
  | {
      kind: 'column-not-null';
      /** Qualified name parts, e.g. ['public', 'orders'] or ['orders']. */
      relation: string[];
      column: string;
      role: 'outer' | 'subquery';
      why: string;
    }
  | {
      kind: 'column-type-supported';
      relation: string[];
      column: string;
      oneOf: string[];
      why: string;
    };

export interface CandidateRewrite {
  kind: GeneratedRewriteKind;
  /** The full rewritten statement, already re-parsed and structurally validated. */
  sql: string;
  /** What was replaced, in the byte domain the parser speaks. */
  byteSpan: { start: number; end: number };
  /** The same span in UTF-16 units, for highlighting in a browser. */
  charSpan: { start: number; end: number };
  replaced: string;
  replacement: string;
  /** Facts `catalog.ts` must establish before this may be executed. */
  preconditions: PreconditionSpec[];
  /** Why this form should plan better. */
  rationale: string;
}

export type CandidateResult =
  | { ok: true; candidate: CandidateRewrite }
  | { ok: false; blocked: string };

type Node = Record<string, unknown>;

// ── offsets ──────────────────────────────────────────────────────────────────

/** UTF-8 byte offset → UTF-16 string index. */
export function byteToCharIndex(sql: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const buf = Buffer.from(sql, 'utf8');
  if (byteOffset >= buf.length) return sql.length;
  return buf.subarray(0, byteOffset).toString('utf8').length;
}

/** UTF-16 string index → UTF-8 byte offset. */
export function charToByteIndex(sql: string, charIndex: number): number {
  if (charIndex <= 0) return 0;
  if (charIndex >= sql.length) return Buffer.byteLength(sql, 'utf8');
  return Buffer.byteLength(sql.slice(0, charIndex), 'utf8');
}

// ── lexical scanners ─────────────────────────────────────────────────────────
//
// The AST gives starts and never ends: no expression node carries a closing
// offset, and stmt_len is absent for a single statement. So the end of a span
// has to be found by scanning, and the scan has to know what a Postgres literal
// looks like or it will match a parenthesis inside a string.

const SQUOTE = 0x27; // '
const DQUOTE = 0x22; // "
const OPEN = 0x28;   // (
const CLOSE = 0x29;  // )
const DASH = 0x2d;   // -
const SLASH = 0x2f;  // /
const STAR = 0x2a;   // *
const NEWLINE = 0x0a;

/** Advance past a quoted run starting at `i`, honouring doubled-quote escapes. */
function skipQuoted(buf: Buffer, i: number, quote: number): number {
  let j = i + 1;
  while (j < buf.length) {
    if (buf[j] === quote) {
      if (buf[j + 1] === quote) { j += 2; continue; } // '' or "" escape
      return j + 1;
    }
    j += 1;
  }
  return buf.length;
}

/** Advance past a comment starting at `i`, or return `i` if none starts there. */
function skipComment(buf: Buffer, i: number): number {
  if (buf[i] === DASH && buf[i + 1] === DASH) {
    let j = i + 2;
    while (j < buf.length && buf[j] !== NEWLINE) j += 1;
    return j;
  }
  if (buf[i] === SLASH && buf[i + 1] === STAR) {
    // Postgres block comments nest.
    let j = i + 2;
    let depth = 1;
    while (j < buf.length && depth > 0) {
      if (buf[j] === SLASH && buf[j + 1] === STAR) { depth += 1; j += 2; continue; }
      if (buf[j] === STAR && buf[j + 1] === SLASH) { depth -= 1; j += 2; continue; }
      j += 1;
    }
    return j;
  }
  return i;
}

/**
 * Index of the `)` matching the `(` at `openIdx`, or -1.
 * Skips string literals, quoted identifiers and both comment forms.
 */
export function matchParen(buf: Buffer, openIdx: number): number {
  if (buf[openIdx] !== OPEN) return -1;
  let depth = 0;
  let i = openIdx;
  while (i < buf.length) {
    const after = skipComment(buf, i);
    if (after !== i) { i = after; continue; }
    const c = buf[i];
    if (c === SQUOTE || c === DQUOTE) { i = skipQuoted(buf, i, c); continue; }
    if (c === OPEN) depth += 1;
    else if (c === CLOSE) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Exclusive end of the literal token beginning at `startIdx`. */
export function literalEnd(buf: Buffer, startIdx: number): number {
  const c = buf[startIdx];
  if (c === SQUOTE) return skipQuoted(buf, startIdx, SQUOTE);
  let i = startIdx;
  if (buf[i] === DASH || buf[i] === 0x2b) i += 1; // leading sign
  while (i < buf.length) {
    const d = buf[i];
    const numeric = (d >= 0x30 && d <= 0x39) || d === 0x2e ||
      d === 0x65 || d === 0x45 || // exponent
      ((d === DASH || d === 0x2b) && (buf[i - 1] === 0x65 || buf[i - 1] === 0x45));
    if (!numeric) break;
    i += 1;
  }
  return i;
}

/** First `(` at or after `from`, skipping literals and comments. */
function nextOpenParen(buf: Buffer, from: number): number {
  let i = from;
  while (i < buf.length) {
    const after = skipComment(buf, i);
    if (after !== i) { i = after; continue; }
    const c = buf[i];
    if (c === SQUOTE || c === DQUOTE) { i = skipQuoted(buf, i, c); continue; }
    if (c === OPEN) return i;
    i += 1;
  }
  return -1;
}

// ── AST helpers ──────────────────────────────────────────────────────────────

const node = (v: unknown): Node | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : null;

/** Postgres quotes an identifier only when it has to; mirror that. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
const RESERVED = new Set([
  'select', 'from', 'where', 'group', 'order', 'limit', 'offset', 'join', 'on',
  'and', 'or', 'not', 'in', 'exists', 'as', 'by', 'having', 'union', 'all',
  'table', 'values', 'user', 'default', 'case', 'when', 'then', 'else', 'end',
]);

/** String parts of a ColumnRef's `fields`, or null if it is not a plain column. */
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

/** Every `location` value inside a subtree. */
function locations(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) { for (const v of value) locations(v, out); return out; }
  const n = node(value);
  if (!n) return out;
  for (const [k, v] of Object.entries(n)) {
    if (k === 'location' && typeof v === 'number' && v >= 0) out.push(v);
    else locations(v, out);
  }
  return out;
}

/** Deep clone with every `location` removed, so trees compare structurally. */
function stripLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLocations);
  const n = node(value);
  if (!n) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === 'location') continue;
    out[k] = stripLocations(v);
  }
  return out;
}

/** Does any node of `type` appear in the subtree? */
function contains(value: unknown, pred: (type: string, n: Node) => boolean): boolean {
  if (Array.isArray(value)) return value.some(v => contains(v, pred));
  const n = node(value);
  if (!n) return false;
  for (const [k, v] of Object.entries(n)) {
    const child = node(v);
    if (child && pred(k, child)) return true;
    if (contains(v, pred)) return true;
  }
  return false;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Positions where two location-stripped trees differ, reported as whole changed
 * subtrees rather than as leaves.
 *
 * Descends only while the shape matches — same array length, identical key sets.
 * The moment the shape diverges, that position *is* the change and we stop, so
 * replacing one node counts once instead of once per differing leaf beneath it.
 */
function divergences(a: unknown, b: unknown, path = '', out: string[] = [], cap = 3): string[] {
  if (out.length >= cap || same(a, b)) return out;

  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) divergences(a[i], b[i], `${path}[${i}]`, out, cap);
    return out;
  }
  const na = node(a);
  const nb = node(b);
  if (na && nb) {
    const ka = Object.keys(na).sort();
    const kb = Object.keys(nb).sort();
    if (ka.length === kb.length && ka.every((k, i) => k === kb[i])) {
      for (const k of ka) {
        divergences(na[k], nb[k], `${path}.${k}`, out, cap);
        if (out.length >= cap) return out;
      }
      return out;
    }
  }
  out.push(path);
  return out;
}

/** Split a path into its `.key` and `[i]` segments. */
const tokens = (path: string): string[] => path.match(/\.[^.[]+|\[\d+\]/g) ?? [];

/** Read a value out of a tree by the path notation `divergences` produces. */
function at(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const tok of tokens(path)) {
    cur = tok.startsWith('[')
      ? (Array.isArray(cur) ? cur[Number(tok.slice(1, -1))] : undefined)
      : node(cur)?.[tok.slice(1)];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Deepest path containing every one of `paths`. */
function commonAncestor(paths: string[]): string {
  const parts = paths.map(tokens);
  const shortest = Math.min(...parts.map(p => p.length));
  let i = 0;
  while (i < shortest && parts.every(p => p[i] === parts[0][i])) i += 1;
  return parts[0].slice(0, i).join('');
}

/** A path and all of its ancestors, deepest first. */
function ancestry(path: string): string[] {
  const toks = tokens(path);
  const out: string[] = [];
  for (let i = toks.length; i >= 0; i--) out.push(toks.slice(0, i).join(''));
  return out;
}

// ── validation ───────────────────────────────────────────────────────────────

/**
 * Confirm the splice changed exactly the node we meant, and nothing else.
 *
 * Compares the reparsed rewritten tree against the original with the expected
 * replacement substituted at the one differing position. Any other change — a
 * mis-scanned paren, a shifted offset, a precedence break introduced by dropping
 * parentheses — leaves a second divergence and fails.
 */
export function validateSplice(originalSql: string, rewrittenSql: string, replacement: string): string | null {
  let rewrittenTree: unknown;
  try {
    rewrittenTree = parseSync(rewrittenSql);
  } catch (err) {
    return `the rewritten statement does not parse: ${(err as Error).message}`;
  }
  const stmts = (node(rewrittenTree)?.['stmts'] as unknown[]) ?? [];
  if (stmts.length !== 1) return 'the rewrite produced more than one statement';

  // What the replacement text means on its own, as a boolean expression.
  let expected: unknown;
  try {
    const probe = parseSync(`SELECT 1 WHERE ${replacement}`);
    expected = ((node(probe)?.['stmts'] as unknown[])?.[0] as Node)?.['stmt'];
    expected = node(node(expected)?.['SelectStmt'])?.['whereClause'];
  } catch {
    return 'the replacement is not a valid boolean expression';
  }
  if (!expected) return 'the replacement produced no expression';

  const before = stripLocations(parseSync(originalSql));
  const after = stripLocations(rewrittenTree);
  const diff = divergences(before, after, '', [], 12);
  if (diff.length === 0) return 'the rewrite changed nothing';

  // Every difference must sit inside one region, and that region must be exactly
  // the text we wrote. Counting divergences alone is the wrong test: replacing
  // `date(c) >= 'D'` with `c >= 'D'::date` keeps the comparison node and changes
  // both of its children, which is two divergences and still one replacement.
  //
  // So: take the deepest node containing all of them, then walk up looking for
  // the replacement. Nothing outside that node changed — that is what makes the
  // containment argument sound — and the node itself is what we meant to write.
  const want = stripLocations(expected);
  const found = ancestry(commonAncestor(diff)).some(p => same(at(after, p), want));
  if (!found) return 'the changed region is not the replacement that was written';
  return null;
}

/** Splice `replacement` over [start, end) in the byte domain and validate. */
function spliceAndValidate(
  sql: string,
  span: { start: number; end: number },
  replacement: string,
  kind: GeneratedRewriteKind,
  preconditions: PreconditionSpec[],
  rationale: string,
): CandidateResult {
  const buf = Buffer.from(sql, 'utf8');
  if (span.start < 0 || span.end > buf.length || span.start >= span.end) {
    return { ok: false, blocked: 'could not locate the fragment to replace' };
  }
  const rewritten = Buffer.concat([
    buf.subarray(0, span.start),
    Buffer.from(replacement, 'utf8'),
    buf.subarray(span.end),
  ]).toString('utf8');

  const problem = validateSplice(sql, rewritten, replacement);
  if (problem) return { ok: false, blocked: problem };

  return {
    ok: true,
    candidate: {
      kind,
      sql: rewritten,
      byteSpan: { ...span },
      charSpan: { start: byteToCharIndex(sql, span.start), end: byteToCharIndex(sql, span.end) },
      replaced: buf.subarray(span.start, span.end).toString('utf8'),
      replacement,
      preconditions,
      rationale,
    },
  };
}

// ── guards shared by the NOT IN transforms ───────────────────────────────────

/**
 * An outer join anywhere in the statement blocks generation.
 *
 * `attnotnull` is a fact about storage, not about the value an expression has at
 * runtime: a NOT NULL column on the nullable side of a LEFT JOIN is NULL in the
 * result. The catalog cannot see that, so the AST has to refuse it.
 */
function hasOuterJoin(stmt: Node): boolean {
  return contains(stmt, (type, n) =>
    type === 'JoinExpr' && typeof n['jointype'] === 'string' && n['jointype'] !== 'JOIN_INNER');
}

/** Relation names visible in the outer FROM, for resolving an unqualified column. */
function outerRelations(stmt: Node): Array<{ parts: string[]; alias: string | null }> {
  const from = stmt['fromClause'];
  if (!Array.isArray(from)) return [];
  const out: Array<{ parts: string[]; alias: string | null }> = [];
  const visit = (v: unknown): void => {
    const rv = node(node(v)?.['RangeVar']);
    if (rv) {
      const parts = [rv['schemaname'], rv['relname']].filter(x => typeof x === 'string') as string[];
      out.push({ parts, alias: (node(rv['alias'])?.['aliasname'] as string) ?? null });
      return;
    }
    const je = node(node(v)?.['JoinExpr']);
    if (je) { visit(je['larg']); visit(je['rarg']); }
  };
  for (const f of from) visit(f);
  return out;
}

/**
 * Resolve the outer column to a qualified reference and the relation it belongs
 * to. Refuses when an unqualified name could bind to more than one relation —
 * guessing here is how a rewrite silently changes meaning.
 */
function resolveOuterColumn(
  parts: string[],
  stmt: Node,
): { qualified: string; relation: string[] } | { blocked: string } {
  const rels = outerRelations(stmt);
  if (parts.length >= 2) {
    const qual = parts.slice(0, -1).join('.');
    const match = rels.find(r => (r.alias ?? r.parts.at(-1)) === parts.at(-2));
    if (!match) return { blocked: `\`${qual}\` does not name a table in this query's FROM clause` };
    return { qualified: parts.map(quoteIdent).join('.'), relation: match.parts };
  }
  if (rels.length !== 1) {
    return {
      blocked: `\`${parts[0]}\` is unqualified and this query reads ${rels.length} tables — ` +
        'qualify it and run the analysis again',
    };
  }
  const only = rels[0];
  const qual = only.alias ?? only.parts.at(-1)!;
  return { qualified: `${quoteIdent(qual)}.${quoteIdent(parts[0])}`, relation: only.parts };
}

/** A name not already used anywhere in the statement text. */
function freshAlias(sql: string, base = 'qn'): string {
  let i = 0;
  while (new RegExp(`\\b${base}_${i}\\b`, 'i').test(sql)) i += 1;
  return `${base}_${i}`;
}

// ── transform: NOT IN (SELECT …) ─────────────────────────────────────────────

/**
 * `x NOT IN (SELECT y FROM t [WHERE p])` → `NOT EXISTS (SELECT 1 FROM t WHERE p AND t.y = x)`.
 *
 * Equivalent exactly when neither `x` nor `y` can be NULL, which is a catalog
 * fact, declared here and checked before anything executes.
 */
export function generateNotInSubquery(sql: string, stmt: Node, link: Node): CandidateResult {
  if (hasOuterJoin(stmt)) {
    return { ok: false, blocked: 'the query contains an outer join, where a NOT NULL column can still be NULL' };
  }
  const outerParts = columnParts(link['testexpr']);
  if (!outerParts) return { ok: false, blocked: 'the left-hand side is an expression, not a plain column' };

  const sub = node(node(link['subselect'])?.['SelectStmt']);
  if (!sub) return { ok: false, blocked: 'the subquery is not a plain SELECT' };
  for (const key of ['distinctClause', 'groupClause', 'havingClause', 'withClause',
                     'limitCount', 'limitOffset', 'larg', 'rarg']) {
    const v = sub[key];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) {
      return { ok: false, blocked: `the subquery uses ${key.replace(/Clause|Count|Offset/, '')}, which changes what it returns` };
    }
  }
  const subFrom = sub['fromClause'];
  if (!Array.isArray(subFrom) || subFrom.length !== 1) {
    return { ok: false, blocked: 'the subquery reads more than one table' };
  }
  const rv = node(node(subFrom[0])?.['RangeVar']);
  if (!rv) return { ok: false, blocked: 'the subquery does not read a plain table' };

  const targets = sub['targetList'];
  if (!Array.isArray(targets) || targets.length !== 1) {
    return { ok: false, blocked: 'the subquery selects more than one column' };
  }
  const innerParts = columnParts(node(node(targets[0])?.['ResTarget'])?.['val']);
  if (!innerParts) return { ok: false, blocked: 'the subquery selects an expression, not a plain column' };

  const outer = resolveOuterColumn(outerParts, stmt);
  if ('blocked' in outer) return { ok: false, blocked: outer.blocked };

  const relParts = [rv['schemaname'], rv['relname']].filter(x => typeof x === 'string') as string[];
  const existingAlias = (node(rv['alias'])?.['aliasname'] as string) ?? null;
  const alias = existingAlias ?? freshAlias(sql);
  // A subquery alias that collides with the outer qualifier would capture the
  // outer reference. Re-aliasing would break references inside the inner WHERE,
  // so refuse rather than rewrite around it.
  const outerQualifier = outer.qualified.split('.')[0].replace(/"/g, '');
  if (alias === outerQualifier) {
    return { ok: false, blocked: `the subquery's alias \`${alias}\` shadows the outer table of the same name` };
  }

  const innerCol = innerParts.at(-1)!;
  const innerRef = `${quoteIdent(alias)}.${quoteIdent(innerCol)}`;
  const relSql = relParts.map(quoteIdent).join('.');

  const buf = Buffer.from(sql, 'utf8');
  const linkLoc = typeof link['location'] === 'number' ? link['location'] : -1;
  const open = nextOpenParen(buf, linkLoc >= 0 ? linkLoc : 0);
  const close = open >= 0 ? matchParen(buf, open) : -1;
  if (open < 0 || close < 0) return { ok: false, blocked: 'could not find the subquery parentheses' };

  const outerLoc = node(node(link['testexpr'])?.['ColumnRef'])?.['location'];
  if (typeof outerLoc !== 'number') return { ok: false, blocked: 'the parser reported no position for the column' };

  // Preserve the inner WHERE verbatim: it may reference the outer query, use
  // functions, or contain anything at all. Regenerating it is not our job.
  let innerWhere = '';
  if (sub['whereClause']) {
    const locs = locations(sub['whereClause']);
    const start = Math.min(...locs);
    if (!Number.isFinite(start)) return { ok: false, blocked: 'could not locate the subquery WHERE clause' };
    innerWhere = buf.subarray(start, close).toString('utf8').trim();
  }

  const aliasSql = existingAlias ? ` AS ${quoteIdent(alias)}` : ` AS ${quoteIdent(alias)}`;
  const where = innerWhere ? `(${innerWhere}) AND ${innerRef} = ${outer.qualified}`
                           : `${innerRef} = ${outer.qualified}`;
  const replacement = `(NOT EXISTS (SELECT 1 FROM ${relSql}${aliasSql} WHERE ${where}))`;

  return spliceAndValidate(
    sql,
    { start: outerLoc, end: close + 1 },
    replacement,
    'not-in-subquery',
    [
      {
        kind: 'column-not-null', relation: outer.relation, column: outerParts.at(-1)!, role: 'outer',
        why: 'NOT IN filters a row whose left-hand value is NULL; NOT EXISTS keeps it. ' +
             'They agree only when this column cannot be NULL.',
      },
      {
        kind: 'column-not-null', relation: relParts, column: innerCol, role: 'subquery',
        why: 'A single NULL from the subquery makes NOT IN return no rows at all, ' +
             'while NOT EXISTS returns the matching ones.',
      },
    ],
    'NOT EXISTS can be executed as a hash anti-join; NOT IN forces a materialised ' +
    'subplan re-checked per row.',
  );
}

// ── transform: NOT IN (list) ─────────────────────────────────────────────────

/**
 * `x NOT IN (a, b, c)` → `NOT EXISTS (SELECT 1 FROM (VALUES (a),(b),(c)) v(v) WHERE v.v = x)`.
 *
 * Deliberately *not* `<> ALL (ARRAY[…])`: that is what Postgres already builds
 * internally for a list, so emitting it would be a no-op wearing a rewrite's
 * clothes. The VALUES form is what unlocks a hash anti-join once the list is
 * long. On a short list the re-plan will honestly report no effect.
 */
export function generateNotInList(sql: string, stmt: Node, expr: Node): CandidateResult {
  if (hasOuterJoin(stmt)) {
    return { ok: false, blocked: 'the query contains an outer join, where a NOT NULL column can still be NULL' };
  }
  const parts = columnParts(expr['lexpr']);
  if (!parts) return { ok: false, blocked: 'the left-hand side is an expression, not a plain column' };

  const items = node(node(expr['rexpr'])?.['List'])?.['items'];
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, blocked: 'the list is empty or not a literal list' };
  }
  const buf = Buffer.from(sql, 'utf8');
  const values: string[] = [];
  for (const item of items) {
    const c = node(node(item)?.['A_Const']);
    if (!c) return { ok: false, blocked: 'the list contains an expression, not a literal' };
    if (c['isnull'] === true) {
      return { ok: false, blocked: 'the list contains NULL, so the predicate already matches nothing' };
    }
    const loc = c['location'];
    if (typeof loc !== 'number') return { ok: false, blocked: 'the parser reported no position for a list item' };
    values.push(buf.subarray(loc, literalEnd(buf, loc)).toString('utf8'));
  }

  const outer = resolveOuterColumn(parts, stmt);
  if ('blocked' in outer) return { ok: false, blocked: outer.blocked };

  const alias = freshAlias(sql);
  const lexprLoc = node(node(expr['lexpr'])?.['ColumnRef'])?.['location'];
  if (typeof lexprLoc !== 'number') return { ok: false, blocked: 'the parser reported no position for the column' };
  const exprLoc = typeof expr['location'] === 'number' ? expr['location'] : -1;
  const open = nextOpenParen(buf, exprLoc >= 0 ? exprLoc : lexprLoc);
  const close = open >= 0 ? matchParen(buf, open) : -1;
  if (close < 0) return { ok: false, blocked: 'could not find the list parentheses' };

  const replacement =
    `(NOT EXISTS (SELECT 1 FROM (VALUES ${values.map(v => `(${v})`).join(', ')}) ` +
    `AS ${quoteIdent(alias)}(v) WHERE ${quoteIdent(alias)}.v = ${outer.qualified}))`;

  return spliceAndValidate(
    sql,
    { start: lexprLoc, end: close + 1 },
    replacement,
    'not-in-list',
    [{
      kind: 'column-not-null', relation: outer.relation, column: parts.at(-1)!, role: 'outer',
      why: 'NOT IN filters a row whose left-hand value is NULL; NOT EXISTS keeps it.',
    }],
    'A VALUES relation can be hashed and anti-joined; a long IN list is checked ' +
    'one element at a time per row.',
  );
}

// ── transform: date(column) op literal ───────────────────────────────────────

const RANGE_FORMS: Record<string, (col: string, lit: string) => string> = {
  '=':  (c, l) => `(${c} >= ${l}::date AND ${c} < ${l}::date + 1)`,
  '<':  (c, l) => `(${c} < ${l}::date)`,
  '<=': (c, l) => `(${c} < ${l}::date + 1)`,
  '>':  (c, l) => `(${c} >= ${l}::date + 1)`,
  '>=': (c, l) => `(${c} >= ${l}::date)`,
};

/**
 * `date(ts) = 'D'` → `ts >= 'D'::date AND ts < 'D'::date + 1`.
 *
 * No NULL precondition: `date(NULL) op D` and the range form both evaluate to
 * NULL and filter the row identically. What it does need is the column's type,
 * because the range form is only equivalent for date/timestamp/timestamptz.
 */
export function generateFunctionOnColumn(sql: string, stmt: Node, expr: Node): CandidateResult {
  const opName = (() => {
    const n = expr['name'];
    if (!Array.isArray(n) || n.length !== 1) return null;
    const s = node(node(n[0])?.['String'])?.['sval'];
    return typeof s === 'string' ? s : null;
  })();
  if (!opName || !(opName in RANGE_FORMS)) {
    return { ok: false, blocked: `\`${opName ?? '?'}\` has no range equivalent` };
  }

  // The call may sit on either side of the operator.
  const lFunc = node(node(expr['lexpr'])?.['FuncCall']);
  const rFunc = node(node(expr['rexpr'])?.['FuncCall']);
  const func = lFunc ?? rFunc;
  const constSide = lFunc ? expr['rexpr'] : expr['lexpr'];
  if (!func || rFunc) {
    // Only the `date(col) op literal` orientation is handled; the mirrored form
    // needs the operator flipped, which is a separate transform.
    if (rFunc) return { ok: false, blocked: 'the function is on the right of the operator' };
    return { ok: false, blocked: 'no function call on either side' };
  }
  const fname = (() => {
    const parts = func['funcname'];
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > 2) return null;
    const last = node(node(parts.at(-1))?.['String'])?.['sval'];
    const schema = parts.length === 2 ? node(node(parts[0])?.['String'])?.['sval'] : 'pg_catalog';
    return typeof last === 'string' && (schema === 'pg_catalog') ? last : null;
  })();
  if (fname !== 'date') {
    return { ok: false, blocked: `${fname ?? 'this function'}() has no range equivalent — the expression-index advice stands` };
  }

  const args = func['args'];
  if (!Array.isArray(args) || args.length !== 1) return { ok: false, blocked: 'date() takes one argument here' };
  const colParts = columnParts(args[0]);
  if (!colParts) return { ok: false, blocked: 'date() wraps an expression, not a plain column' };

  const constNode = node(node(constSide)?.['A_Const']);
  if (!constNode || constNode['isnull'] === true) {
    return { ok: false, blocked: 'the comparison value is not a literal' };
  }
  const constLoc = constNode['location'];
  const funcLoc = func['location'];
  if (typeof constLoc !== 'number' || typeof funcLoc !== 'number') {
    return { ok: false, blocked: 'the parser reported no position for the comparison' };
  }

  const resolved = resolveOuterColumn(colParts, stmt);
  if ('blocked' in resolved) return { ok: false, blocked: resolved.blocked };

  const buf = Buffer.from(sql, 'utf8');
  const literal = buf.subarray(constLoc, literalEnd(buf, constLoc)).toString('utf8');
  const start = Math.min(funcLoc, constLoc);
  const end = Math.max(literalEnd(buf, constLoc), matchParen(buf, nextOpenParen(buf, funcLoc)) + 1);

  const replacement = RANGE_FORMS[opName](resolved.qualified, literal);

  return spliceAndValidate(
    sql, { start, end }, replacement, 'function-on-column',
    [{
      kind: 'column-type-supported', relation: resolved.relation, column: colParts.at(-1)!,
      oneOf: ['date', 'timestamp without time zone', 'timestamp with time zone'],
      why: 'The half-open range is equivalent to date() only for a date or timestamp column.',
    }],
    'A bare column on one side of the comparison lets a plain b-tree index on it ' +
    'be used; date() over it cannot be.',
  );
}
