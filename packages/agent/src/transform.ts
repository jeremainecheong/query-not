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

export type GeneratedRewriteKind =
  | 'not-in-subquery'
  | 'not-in-list'
  | 'function-on-column'
  | 'or-across-columns'
  | 'correlated-subquery-in-select';

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
    }
  | {
      /**
       * A unique index whose key columns are a subset of `columns` must exist
       * on `relation`. Equality on every pinned column then admits at most one
       * row — the fact that stops a LEFT JOIN fanning out where the scalar
       * subquery it replaces would have raised an error.
       */
      kind: 'unique-key-covers';
      relation: string[];
      columns: string[];
      why: string;
    }
  | {
      /**
       * None of `functions` may resolve to an aggregate. `sum(x)` and
       * `upper(x)` are indistinguishable in the parse tree — aggregate-ness
       * lives in pg_proc — and a transform that re-shapes the statement around
       * an unnoticed aggregate changes what it computes.
       */
      kind: 'function-not-aggregate';
      functions: string[];
      why: string;
    }
  | {
      /**
       * The mirror image: the call must BE an aggregate. The grouped-join
       * rewrite moves the call into a GROUP BY derived table, which only
       * computes the same thing if the function aggregates its group — a
       * schema's ordinary function named `count` would make the two forms
       * mean different things, so the name has to be proven in pg_proc
       * before anything executes.
       */
      kind: 'function-is-aggregate';
      functions: string[];
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

// ── word tokens ──────────────────────────────────────────────────────────────
//
// The statement-rebuilding transforms need clause boundaries — where WHERE
// ends, where ORDER BY starts — and the AST does not carry them (SortBy nodes
// report location -1). A single literal-and-comment-aware pass that records
// every bare word with its paren depth answers all of those questions: a
// depth-relative occurrence of a reserved clause keyword *is* the clause,
// because an unquoted reserved word cannot be an identifier.

interface WordToken {
  start: number;
  /** Exclusive. */
  end: number;
  depth: number;
  upper: string;
}

const isWordStart = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
// Bytes ≥ 0x80 continue a word: `froméx` is one identifier, and treating its
// ASCII prefix as a token would fabricate a FROM keyword out of a column name.
const isWordCont = (c: number): boolean =>
  isWordStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x24 || c >= 0x80;

function wordTokens(buf: Buffer, from = 0, to = buf.length, baseDepth = 0): WordToken[] {
  const out: WordToken[] = [];
  let depth = baseDepth;
  let i = from;
  while (i < to) {
    const after = skipComment(buf, i);
    if (after !== i) { i = after; continue; }
    const c = buf[i];
    if (c === SQUOTE || c === DQUOTE) { i = skipQuoted(buf, i, c); continue; }
    if (c === OPEN) { depth += 1; i += 1; continue; }
    if (c === CLOSE) { depth -= 1; i += 1; continue; }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < to && isWordCont(buf[j])) j += 1;
      out.push({ start: i, end: j, depth, upper: buf.subarray(i, j).toString('latin1').toUpperCase() });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Only whitespace, comments and `(` between `from` and `to`? */
function gapIsOpeners(buf: Buffer, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    const after = skipComment(buf, i);
    if (after !== i) { i = after; continue; }
    const c = buf[i];
    if (c === OPEN || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) { i += 1; continue; }
    return false;
  }
  return true;
}

/**
 * Exclusive end of the statement's own text: everything before trailing
 * whitespace, semicolons and comments. Needed because a rebuilt statement must
 * not carry the terminator into the middle of the new text.
 */
function statementEnd(buf: Buffer): number {
  let last = 0;
  let i = 0;
  while (i < buf.length) {
    const after = skipComment(buf, i);
    if (after !== i) { i = after; continue; }
    const c = buf[i];
    if (c === SQUOTE || c === DQUOTE) { const j = skipQuoted(buf, i, c); last = j; i = j; continue; }
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x3b /* ; */) last = i + 1;
    i += 1;
  }
  return last;
}

/**
 * Drop unmatched trailing `)` from a fragment sliced out of a larger
 * expression. An arm of `WHERE (a = 1) OR b = 2` starts *inside* its
 * parenthesis — the parser reports the expression, not the grouping — so the
 * slice ends with closers whose openers were never included. Anything else
 * unbalanced is a scan failure and refuses.
 */
function stripUnbalancedTail(text: string): string | null {
  const balance = (t: string): { final: number; min: number } => {
    const buf = Buffer.from(t, 'utf8');
    let depth = 0;
    let min = 0;
    let i = 0;
    while (i < buf.length) {
      const after = skipComment(buf, i);
      if (after !== i) { i = after; continue; }
      const c = buf[i];
      if (c === SQUOTE || c === DQUOTE) { i = skipQuoted(buf, i, c); continue; }
      if (c === OPEN) depth += 1;
      if (c === CLOSE) { depth -= 1; if (depth < min) min = depth; }
      i += 1;
    }
    return { final: depth, min };
  };

  // Strip one trailing `)` at a time, re-balancing after each: a closer that is
  // *not* at the tail (`b) AND (c))` — the first `)` is the excess one) cannot
  // be fixed by end-stripping, and that loop shape refuses it instead of
  // removing a matched closer.
  let out = text.replace(/[\s;]+$/, '');
  let b = balance(out);
  while (b.min < 0) {
    if (!out.endsWith(')')) return null;
    out = out.slice(0, -1).replace(/\s+$/, '');
    b = balance(out);
  }
  return b.final === 0 ? out : null;
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

/** Structural equality with key order ignored — `same()` is order-sensitive. */
const equalAst = (a: unknown, b: unknown): boolean => divergences(a, b, '', [], 1).length === 0;

const clone = <T,>(v: T): T => structuredClone(v);

/**
 * Validation for rewrites that rebuild the statement rather than splice one
 * region: construct the tree the rewritten text *must* parse to — derived from
 * the original parse tree by the same structural operation the text transform
 * claims to perform — and require the reparse to equal it, locations stripped.
 *
 * Stronger than region containment: every node of the rewritten statement is
 * accounted for, so a slicing bug anywhere — a dropped predicate, an ORDER BY
 * absorbed into an arm, a join attached at the wrong level — is a mismatch and
 * the candidate is withheld.
 */
export function validateReconstruction(rewrittenSql: string, expectedStmt: Node): string | null {
  let tree: unknown;
  try {
    tree = parseSync(rewrittenSql);
  } catch (err) {
    return `the rewritten statement does not parse: ${(err as Error).message}`;
  }
  const stmts = (node(tree)?.['stmts'] as unknown[]) ?? [];
  if (stmts.length !== 1) return 'the rewrite produced more than one statement';
  const got = stripLocations((node(stmts[0]) as Node)?.['stmt']);
  const want = stripLocations(expectedStmt);
  if (!equalAst(want, got)) {
    const diff = divergences(want, got, '', [], 3);
    return `the rewritten statement does not parse to the intended structure (at ${diff.join(', ') || 'root'})`;
  }
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
): { qualified: string; qualifierRaw: string; relation: string[] } | { blocked: string } {
  const rels = outerRelations(stmt);
  if (parts.length >= 2) {
    const qual = parts.slice(0, -1).join('.');
    const match = rels.find(r => (r.alias ?? r.parts.at(-1)) === parts.at(-2));
    if (!match) return { blocked: `\`${qual}\` does not name a table in this query's FROM clause` };
    return { qualified: parts.map(quoteIdent).join('.'), qualifierRaw: parts.at(-2)!, relation: match.parts };
  }
  if (rels.length !== 1) {
    return {
      blocked: `\`${parts[0]}\` is unqualified and this query reads ${rels.length} tables — ` +
        'qualify it and run the analysis again',
    };
  }
  const only = rels[0];
  const qual = only.alias ?? only.parts.at(-1)!;
  return {
    qualified: `${quoteIdent(qual)}.${quoteIdent(parts[0])}`,
    qualifierRaw: qual,
    relation: only.parts,
  };
}

/** Does any qualified ColumnRef in the subtree use `name` as its qualifier? */
function referencesQualifier(value: unknown, name: string): boolean {
  return contains(value, (type, n) => {
    if (type !== 'ColumnRef') return false;
    const fields = n['fields'];
    if (!Array.isArray(fields) || fields.length < 2) return false;
    const qual = node(node(fields[fields.length - 2])?.['String'])?.['sval'];
    return qual === name;
  });
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
  const relname = relParts.at(-1)!;
  const existingAlias = (node(rv['alias'])?.['aliasname'] as string) ?? null;

  // The name that will qualify the subquery's column in the rewrite. An existing
  // alias keeps meaning exactly what it meant. A bare table keeps its own name —
  // inventing an alias would hide that name from the inner WHERE we preserve
  // verbatim, so `order_items.qty` under `FROM order_items AS qn_0` would stop
  // meaning the inner table, and would silently bind to an outer table of that
  // name if one existed. That is the scope-capture failure this module exists
  // to never produce.
  let alias = existingAlias ?? relname;
  let aliasSql = existingAlias ? ` AS ${quoteIdent(existingAlias)}` : '';
  if (alias === outer.qualifierRaw) {
    if (existingAlias) {
      // Re-aliasing would break references inside the preserved inner WHERE.
      return { ok: false, blocked: `the subquery's alias \`${alias}\` shadows the outer table of the same name` };
    }
    if (referencesQualifier(sub['whereClause'], relname)) {
      return {
        ok: false,
        blocked: `the subquery refers to \`${relname}\` by name while the outer query is addressed the same ` +
          'way — aliasing either side would change what the reference means',
      };
    }
    // Self NOT IN against the same bare table, with nothing inside naming it:
    // a fresh alias is safe, and required to tell the two copies apart.
    alias = freshAlias(sql);
    aliasSql = ` AS ${quoteIdent(alias)}`;
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

// ── shared pieces for the statement-rebuilding transforms ────────────────────

/** First token position of a subtree, or -1 when the parser reported none. */
function minLocation(value: unknown): number {
  const locs = locations(value);
  return locs.length > 0 ? Math.min(...locs) : -1;
}

/**
 * Clause keywords that can follow WHERE at the top level of a SELECT. Reserved
 * words, so a depth-0 occurrence is the clause itself and never an identifier.
 */
const CLAUSE_KEYWORDS = new Set([
  'GROUP', 'HAVING', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'FOR',
  'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'INTO',
]);

/** A clause field that is present and non-empty. */
const hasClause = (sel: Node, key: string): boolean => {
  const v = sel[key];
  return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
};

/**
 * Function names called in a subtree, plus the two things about a call that
 * are aggregate- or window-shaped *syntactically* and refuse structurally.
 * Plain `sum(x)` is indistinguishable from `upper(x)` here — that distinction
 * is pg_proc's, so it comes back as a `function-not-aggregate` precondition.
 */
function functionUse(value: unknown): { names: string[]; refused: string | null } {
  const names = new Set<string>();
  let refused: string | null = null;
  const visit = (v: unknown): void => {
    if (refused) return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const n = node(v);
    if (!n) return;
    for (const [k, val] of Object.entries(n)) {
      const child = node(val);
      if (k === 'FuncCall' && child) {
        if (child['over']) { refused = 'a window function'; return; }
        if (child['agg_star'] || child['agg_distinct'] || child['agg_order'] ||
            child['agg_filter'] || child['agg_within_group']) {
          refused = 'an aggregate call';
          return;
        }
        const name = lastSval(child['funcname']);
        if (name) names.add(name.toLowerCase());
      }
      visit(val);
    }
  };
  visit(value);
  return { names: [...names].sort(), refused };
}

/** Names (aliases or bare table names) addressable in a FROM clause. */
function fromClauseNames(from: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    const n = node(v);
    if (!n) return;
    const rv = node(n['RangeVar']);
    if (rv) {
      out.add((node(rv['alias'])?.['aliasname'] as string) ?? (rv['relname'] as string));
      return;
    }
    const je = node(n['JoinExpr']);
    if (je) {
      visit(je['larg']);
      visit(je['rarg']);
      const alias = node(je['alias'])?.['aliasname'];
      if (typeof alias === 'string') out.add(alias);
      return;
    }
    for (const key of ['RangeSubselect', 'RangeFunction', 'RangeTableFunc', 'RangeTableSample']) {
      const item = node(n[key]);
      const alias = node(item?.['alias'])?.['aliasname'];
      if (typeof alias === 'string') out.add(alias);
      if (item) return;
    }
  };
  if (Array.isArray(from)) for (const f of from) visit(f);
  return out;
}

/** The statement count of the whole input — a rebuild must not drop a sibling. */
function inputStatementCount(sql: string): number {
  try {
    return ((node(parseSync(sql))?.['stmts'] as unknown[]) ?? []).length;
  } catch {
    return -1;
  }
}

// ── transform: OR across columns → UNION ALL of exclusive arms ───────────────

/**
 * `WHERE a OR b` → `(… WHERE a) UNION ALL (… WHERE b AND (a) IS NOT TRUE)`.
 *
 * The guards are what make this exact rather than approximate: each arm takes
 * only the rows no earlier arm took, so the arms partition the original result
 * multiset. `IS NOT TRUE` rather than `NOT` is deliberate — a row where the
 * earlier arm evaluates to NULL did not match it, and must not be lost from
 * the later arm the way `AND NOT (arm)` would lose it. No schema fact is
 * involved; when the target list calls functions, their non-aggregate-ness is
 * the one thing that cannot be read off the tree and becomes a precondition.
 *
 * ORDER BY / LIMIT / OFFSET hoist to the set operation, where they keep their
 * meaning; each arm can then be served by its own index, which is the point.
 */
export function generateOrSplit(sql: string, sel: Node, orExpr: Node): CandidateResult {
  if (inputStatementCount(sql) !== 1) {
    return { ok: false, blocked: 'the input contains more than one statement' };
  }
  if (sel['op'] !== 'SETOP_NONE') {
    return { ok: false, blocked: 'the statement is already a set operation' };
  }
  if (node(sel['whereClause'])?.['BoolExpr'] !== orExpr) {
    return {
      ok: false,
      blocked: 'the OR sits inside a larger predicate — only an OR that is the whole ' +
        'WHERE clause splits into arms that mean the same thing',
    };
  }

  for (const [key, why] of [
    ['withClause', 'a WITH query — each arm would need its own copy of the CTE'],
    ['distinctClause', 'DISTINCT — de-duplicating per arm is not de-duplicating the whole result'],
    ['groupClause', 'GROUP BY — the split would aggregate per arm instead of once'],
    ['havingClause', 'HAVING — the split would aggregate per arm instead of once'],
    ['windowClause', 'a window clause — window functions would see one arm, not the whole result'],
    ['lockingClause', 'FOR UPDATE/SHARE — row locking does not distribute over a set operation'],
    ['intoClause', 'SELECT INTO'],
  ] as const) {
    if (hasClause(sel, key)) return { ok: false, blocked: `the query uses ${why}` };
  }

  const use = functionUse(sel['targetList']);
  if (use.refused) {
    return { ok: false, blocked: `the select list contains ${use.refused}, which would be evaluated per arm` };
  }

  // ORDER BY over a set operation resolves against output column names only.
  const targets = Array.isArray(sel['targetList']) ? (sel['targetList'] as unknown[]) : [];
  let hasStar = false;
  const outputNames = new Set<string>();
  for (const t of targets) {
    const rt = node(node(t)?.['ResTarget']);
    if (!rt) continue;
    if (typeof rt['name'] === 'string') { outputNames.add(rt['name'] as string); continue; }
    const fields = node(node(rt['val'])?.['ColumnRef'])?.['fields'];
    if (Array.isArray(fields)) {
      if (fields.some(f => node(f)?.['A_Star'] !== undefined)) { hasStar = true; continue; }
      const last = node(node(fields.at(-1))?.['String'])?.['sval'];
      if (typeof last === 'string') outputNames.add(last);
    }
  }
  const sorts = Array.isArray(sel['sortClause']) ? (sel['sortClause'] as unknown[]) : [];
  if (sorts.length > 0 && hasStar) {
    return {
      ok: false,
      blocked: 'SELECT * with ORDER BY — whether the sort key is an output column of every ' +
        'arm cannot be confirmed without the catalog',
    };
  }
  for (const s of sorts) {
    const sb = node(node(s)?.['SortBy']);
    const key = sb?.['node'];
    const ordinal = node(node(key)?.['A_Const'])?.['ival'] !== undefined;
    const parts = columnParts(key);
    const named = parts !== null && parts.length === 1 && outputNames.has(parts[0]);
    if (!ordinal && !named) {
      return {
        ok: false,
        blocked: 'ORDER BY over a set operation can only use output column names or ordinals — ' +
          'a qualified column or an expression stops resolving once the arms are separate queries',
      };
    }
  }

  const args = Array.isArray(orExpr['args']) ? (orExpr['args'] as unknown[]) : [];
  if (args.length < 2) return { ok: false, blocked: 'the OR has fewer than two arms' };
  const armLocs = args.map(minLocation);
  if (armLocs.some(l => l < 0) || armLocs.some((l, i) => i > 0 && l <= armLocs[i - 1])) {
    return { ok: false, blocked: 'the parser reported no usable positions for the arms' };
  }

  const buf = Buffer.from(sql, 'utf8');
  const toks = wordTokens(buf);
  const whereTok = toks.filter(t => t.depth === 0 && t.upper === 'WHERE' && t.end <= armLocs[0]).at(-1);
  if (!whereTok) return { ok: false, blocked: 'could not locate the WHERE keyword' };

  const boundary = toks.find(t => t.depth === 0 && t.start > armLocs[0] && CLAUSE_KEYWORDS.has(t.upper));
  const stmtEnd = statementEnd(buf);
  const whereEnd = boundary ? boundary.start : stmtEnd;

  const armTexts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    let end: number;
    if (i < args.length - 1) {
      const sep = toks
        .filter(t => t.upper === 'OR' && t.start >= armLocs[i] && t.end <= armLocs[i + 1] &&
                     gapIsOpeners(buf, t.end, armLocs[i + 1]))
        .at(-1);
      if (!sep) return { ok: false, blocked: 'could not locate the OR that separates the arms' };
      end = sep.start;
    } else {
      end = whereEnd;
    }
    const text = stripUnbalancedTail(buf.subarray(armLocs[i], end).toString('utf8'));
    if (text === null || text.length === 0) {
      return { ok: false, blocked: 'an arm of the OR could not be sliced out cleanly' };
    }
    armTexts.push(text);
  }

  const prefix = buf.subarray(0, whereTok.end).toString('utf8');
  const tail = buf.subarray(whereEnd, stmtEnd).toString('utf8').trim();

  // Arms are deliberately not parenthesised: none carries its own ORDER BY or
  // LIMIT (those hoist to the set operation, where the grammar binds a trailing
  // clause anyway), and a statement that starts with `(` fails the read-only
  // admission gate every query must pass before it is EXPLAINed.
  const armSql = armTexts.map((text, i) => {
    const guards = armTexts.slice(0, i).map(g => ` AND (${g}) IS NOT TRUE`);
    return `${prefix} ${text}${guards.join('')}`;
  });
  const rewritten = armSql.join('\nUNION ALL\n') + (tail ? `\n${tail}` : '');

  // The tree this text must parse to, built from the original tree by the same
  // operation: clone the SELECT per arm, replace the WHERE, hoist the tail.
  const armSelect = (i: number): Node => {
    const s = clone(sel);
    delete s['sortClause'];
    delete s['limitCount'];
    delete s['limitOffset'];
    s['limitOption'] = 'LIMIT_OPTION_DEFAULT';
    const guards = args.slice(0, i).map(a => ({
      BooleanTest: { arg: clone(a), booltesttype: 'IS_NOT_TRUE' },
    }));
    if (guards.length === 0) {
      s['whereClause'] = clone(args[i]);
    } else {
      const base = clone(args[i]);
      const baseBool = node(node(base)?.['BoolExpr']);
      // Reparsing flattens AND chains, so an arm that is itself an AND must
      // splice its guards into the flat args list, not nest beneath it.
      s['whereClause'] = baseBool && baseBool['boolop'] === 'AND_EXPR'
        ? { BoolExpr: { boolop: 'AND_EXPR', args: [...(baseBool['args'] as unknown[]), ...guards] } }
        : { BoolExpr: { boolop: 'AND_EXPR', args: [base, ...guards] } };
    }
    return s;
  };

  let expected: Node = armSelect(0);
  for (let i = 1; i < args.length; i += 1) {
    expected = {
      op: 'SETOP_UNION',
      all: true,
      larg: expected,
      rarg: armSelect(i),
      limitOption: 'LIMIT_OPTION_DEFAULT',
    };
  }
  if (sel['sortClause']) expected['sortClause'] = clone(sel['sortClause']);
  if (sel['limitCount']) expected['limitCount'] = clone(sel['limitCount']);
  if (sel['limitOffset']) expected['limitOffset'] = clone(sel['limitOffset']);
  expected['limitOption'] = sel['limitOption'] ?? 'LIMIT_OPTION_DEFAULT';

  const problem = validateReconstruction(rewritten, { SelectStmt: expected });
  if (problem) return { ok: false, blocked: problem };

  const preconditions: PreconditionSpec[] = use.names.length > 0
    ? [{
        kind: 'function-not-aggregate',
        functions: use.names,
        why: 'The arms each run the select list; an aggregate there would collapse each arm ' +
             'separately instead of the whole result once.',
      }]
    : [];

  return {
    ok: true,
    candidate: {
      kind: 'or-across-columns',
      sql: rewritten,
      byteSpan: { start: 0, end: stmtEnd },
      charSpan: { start: 0, end: byteToCharIndex(sql, stmtEnd) },
      replaced: buf.subarray(0, stmtEnd).toString('utf8'),
      replacement: rewritten,
      preconditions,
      rationale:
        'Each arm can use its own index instead of forcing one plan to satisfy both sides of the OR. ' +
        'The IS NOT TRUE guards make the arms mutually exclusive — every original row lands in exactly ' +
        'one arm, NULLs included — so no de-duplication is needed and none is added.',
    },
  };
}

// ── transform: top-1-per-key subquery → LEFT JOIN LATERAL ────────────────────

/**
 * `(SELECT x FROM i WHERE i.k = o.k ORDER BY s LIMIT 1)` in the select list
 *   → `LEFT JOIN LATERAL (SELECT x FROM i WHERE i.k = o.k ORDER BY s LIMIT 1) qn ON true`.
 *
 * The lateral body is the ORIGINAL subquery text verbatim, parentheses and
 * all — a lateral subquery is its own scope exactly like the scalar subquery
 * was, so nothing inside needs re-slicing, re-qualifying or alias policing.
 * That is why this path carries far fewer guards than the plain-join one.
 *
 * Both forms return NULL on no match and at most one row (the LIMIT). What
 * neither form fixes is a TIE in the ORDER BY: each picks an arbitrary tied
 * row, and possibly different ones — so the precondition is a unique index
 * within (correlation columns ∪ sort columns), which is what makes the pick
 * deterministic and the two forms comparable at all.
 */
export function generateLateralTop1(
  sql: string,
  sel: Node,
  link: Node,
  sub: Node,
  targetIndex: number,
): CandidateResult {
  for (const [key, why] of [
    ['groupClause', 'the outer query groups — the joined value would itself need grouping'],
    ['havingClause', 'the outer query groups — the joined value would itself need grouping'],
    ['lockingClause', 'FOR UPDATE cannot lock the nullable side of an outer join'],
    ['intoClause', 'SELECT INTO'],
  ] as const) {
    if (hasClause(sel, key)) return { ok: false, blocked: why };
  }

  const subTargets = sub['targetList'];
  if (!Array.isArray(subTargets) || subTargets.length !== 1) {
    return { ok: false, blocked: 'the subquery returns more than one column' };
  }
  const target = node(node(subTargets[0])?.['ResTarget']);
  const val = target?.['val'];
  // The hoisted reference needs a name the join can address. An AS alias or a
  // plain column keeps its name; an anonymous expression becomes `?column?`,
  // which is not a name anyone should generate references to.
  const explicitName = typeof target?.['name'] === 'string' ? (target['name'] as string) : null;
  const columnName = (() => {
    const parts = columnParts(val);
    return parts ? parts.at(-1)! : null;
  })();
  const outName = explicitName ?? columnName;
  if (!outName) {
    return {
      ok: false,
      blocked: 'the subquery selects an anonymous expression — give it a name with AS so the ' +
        'join can reference it',
    };
  }

  // Determinism argument needs a single inner table to pin.
  const subFrom = sub['fromClause'];
  const rv = Array.isArray(subFrom) && subFrom.length === 1 ? node(node(subFrom[0])?.['RangeVar']) : null;
  if (!rv) {
    return {
      ok: false,
      blocked: 'the subquery reads more than one table — no single unique index can make its ' +
        'top-1 choice deterministic',
    };
  }
  const innerRelParts = [rv['schemaname'], rv['relname']].filter(x => typeof x === 'string') as string[];
  const innerName = (node(rv['alias'])?.['aliasname'] as string) ?? (rv['relname'] as string);

  const outerNames = fromClauseNames(sel['fromClause']);
  const refsOuter = contains(sub, (type, n) => {
    if (type !== 'ColumnRef') return false;
    const fields = n['fields'];
    if (!Array.isArray(fields) || fields.length < 2) return false;
    const qual = node(node(fields[fields.length - 2])?.['String'])?.['sval'];
    return typeof qual === 'string' && qual !== innerName && outerNames.has(qual);
  });
  if (!refsOuter) {
    return {
      ok: false,
      blocked: 'the subquery is not correlated — Postgres already runs it once, not per row ' +
        '(or the correlation uses unqualified names; qualify them)',
    };
  }

  const outerFrom = sel['fromClause'];
  if (!Array.isArray(outerFrom) || outerFrom.length !== 1) {
    return {
      ok: false,
      blocked: 'the outer FROM is a comma-separated list — a LEFT JOIN attaches to the last item ' +
        'only, which is not where the correlation may point',
    };
  }

  // Pinned columns for the determinism precondition: correlated equality
  // conjuncts (inner column = something with no inner reference), plus every
  // plain-column sort key. Unclassifiable conjuncts just contribute nothing —
  // fewer pins make the precondition harder to establish, never easier.
  const whereBool = node(node(sub['whereClause'])?.['BoolExpr']);
  const conjuncts = whereBool && whereBool['boolop'] === 'AND_EXPR' && Array.isArray(whereBool['args'])
    ? (whereBool['args'] as unknown[])
    : sub['whereClause'] ? [sub['whereClause']] : [];
  // An inner column is fixed per outer row only when it is equated to an
  // OUTER reference. Requiring the other side to positively name an outer table
  // — not merely to "not name the inner one" — is the load-bearing distinction:
  // `i.parent_id = alt_id`, where alt_id is another inner column, has no
  // qualifier and would otherwise slip through, pinning a column that varies
  // within the group. The determinism certificate then covers a column that is
  // not fixed, and a tie on the sort key picks an arbitrary row.
  const refsOuterName = (v: unknown): boolean =>
    contains(v, (type, n) => {
      if (type !== 'ColumnRef') return false;
      const fields = n['fields'];
      if (!Array.isArray(fields) || fields.length < 2) return false;
      const qual = node(node(fields[fields.length - 2])?.['String'])?.['sval'];
      return typeof qual === 'string' && qual !== innerName && outerNames.has(qual);
    });
  const pinned = new Set<string>();
  for (const c of conjuncts) {
    const ex = node(node(c)?.['A_Expr']);
    if (!ex || ex['kind'] !== 'AEXPR_OP' || lastSval(ex['name']) !== '=') continue;
    for (const [colSide, otherSide] of [['lexpr', 'rexpr'], ['rexpr', 'lexpr']] as const) {
      const parts = columnParts(ex[colSide]);
      if (parts && parts.length >= 2 && parts.at(-2) === innerName &&
          refsOuterName(ex[otherSide]) && !referencesQualifier(ex[otherSide], innerName)) {
        pinned.add(parts.at(-1)!);
      }
    }
  }
  // Sort keys join the pin set only when they are demonstrably INNER columns —
  // bare, or qualified by the inner name. An outer-qualified sort key is
  // constant within each group and contributes nothing to determinism, and
  // adding its name to the probe would ask pg_index about a column that may
  // not exist on the inner table at all.
  const sortCols = new Set<string>();
  const sorts = Array.isArray(sub['sortClause']) ? (sub['sortClause'] as unknown[]) : [];
  for (const s of sorts) {
    const parts = columnParts(node(node(s)?.['SortBy'])?.['node']);
    if (parts && (parts.length === 1 || parts.at(-2) === innerName)) {
      pinned.add(parts.at(-1)!);
      sortCols.add(parts.at(-1)!);
    }
  }
  if (pinned.size === 0) {
    return { ok: false, blocked: 'no plain columns pin the top-1 choice — nothing for a unique index to cover' };
  }

  // ── text: verbatim body, fresh alias, reference swap ───────────────────────
  const buf = Buffer.from(sql, 'utf8');
  const linkLoc = typeof link['location'] === 'number' ? link['location'] : -1;
  const open = linkLoc >= 0 && buf[linkLoc] === OPEN ? linkLoc : nextOpenParen(buf, Math.max(linkLoc, 0));
  const close = open >= 0 ? matchParen(buf, open) : -1;
  if (close < 0) return { ok: false, blocked: 'could not find the subquery parentheses' };

  const alias = freshAlias(sql);
  const bodyText = buf.subarray(open, close + 1).toString('utf8');
  const replacementExpr = `${quoteIdent(alias)}.${quoteIdent(outName)}`;

  const outerFromStart = minLocation(outerFrom);
  const globalToks = wordTokens(buf);
  const stmtEnd = statementEnd(buf);
  const boundary = globalToks.find(
    t => t.depth === 0 && t.start > outerFromStart && (t.upper === 'WHERE' || CLAUSE_KEYWORDS.has(t.upper)),
  );
  const insertAt = boundary ? boundary.start : stmtEnd;
  if (insertAt <= close) return { ok: false, blocked: 'the outer FROM ends before the subquery — unexpected shape' };

  const joinText = ` LEFT JOIN LATERAL ${bodyText} ${quoteIdent(alias)} ON true `;
  const rewritten = (
    buf.subarray(0, open).toString('utf8') +
    replacementExpr +
    buf.subarray(close + 1, insertAt).toString('utf8') +
    joinText +
    buf.subarray(insertAt).toString('utf8')
  ).trimEnd();

  const expected = clone(sel);
  (node(node((expected['targetList'] as unknown[])[targetIndex])?.['ResTarget']) as Node)['val'] = {
    ColumnRef: { fields: [{ String: { sval: alias } }, { String: { sval: outName } }] },
  };
  expected['fromClause'] = [{
    JoinExpr: {
      jointype: 'JOIN_LEFT',
      larg: clone(outerFrom[0]),
      rarg: {
        RangeSubselect: {
          lateral: true,
          subquery: clone(link['subselect']),
          alias: { aliasname: alias },
        },
      },
      quals: { A_Const: { boolval: { boolval: true } } },
    },
  }];

  const problem = validateReconstruction(rewritten, { SelectStmt: expected });
  if (problem) return { ok: false, blocked: problem };

  return {
    ok: true,
    candidate: {
      kind: 'correlated-subquery-in-select',
      sql: rewritten,
      byteSpan: { start: open, end: close + 1 },
      charSpan: { start: byteToCharIndex(sql, open), end: byteToCharIndex(sql, close + 1) },
      replaced: buf.subarray(open, close + 1).toString('utf8'),
      replacement: replacementExpr,
      preconditions: [
        {
          kind: 'unique-key-covers',
          relation: innerRelParts,
          columns: [...pinned].sort(),
          why: 'With a tie in the ORDER BY, both forms pick an arbitrary row — possibly different ' +
               'ones — so equality of results cannot even be tested honestly. A unique index within ' +
               'the correlation and sort columns makes the pick deterministic.',
        },
        // NULLs sort as a single group, and a unique index does not collapse
        // them (NULLS DISTINCT is the default) — so a nullable sort column
        // reintroduces exactly the tie the unique index was supposed to break.
        ...[...sortCols].sort().map((column): PreconditionSpec => ({
          kind: 'column-not-null',
          relation: innerRelParts,
          column,
          role: 'subquery',
          why: 'a unique index leaves NULLs tied — several rows can carry NULL in this sort ' +
               'column, and the top-1 pick among them is arbitrary in both forms.',
        })),
      ],
      rationale:
        'The lateral join is the same per-row top-1 the subquery was, stated where the planner ' +
        'can drive it from an index on the sort column — one ordered probe per row instead of ' +
        'a filtered sort. Without such an index, expect the honest verdict to be no effect.',
    },
  };
}

// ── transform: aggregate subquery → grouped LEFT JOIN ────────────────────────

/** Aggregates whose empty-group value this transform can state exactly. */
const GROUPABLE_AGGREGATES = new Set(['count', 'sum', 'min', 'max', 'avg']);

/**
 * `(SELECT count(*) FROM i WHERE i.k = o.k)` in the select list
 *   → `LEFT JOIN (SELECT i.k, count(*) AS agg FROM i GROUP BY i.k) qn ON qn.k = o.k`,
 *     selecting `COALESCE(qn.agg, 0)`.
 *
 * The derived table groups by the correlation columns, so it has at most one
 * row per key BY CONSTRUCTION — no unique-index precondition, and no fan-out
 * to rule out. What must be proven instead is that the call IS an aggregate
 * (pg_proc, prokind = 'a'): a schema's ordinary function named `count` would
 * make the grouped form compute something else entirely.
 *
 * Value mapping on no match: count returns 0 where the join produces NULL —
 * hence the COALESCE — while sum/min/max/avg return NULL over an empty group,
 * which is exactly the join's NULL already.
 */
export function generateGroupedJoin(
  sql: string,
  sel: Node,
  link: Node,
  sub: Node,
  targetIndex: number,
): CandidateResult {
  for (const [key, why] of [
    ['groupClause', 'the outer query groups — the joined value would itself need grouping'],
    ['havingClause', 'the outer query groups — the joined value would itself need grouping'],
    ['lockingClause', 'FOR UPDATE cannot lock the nullable side of an outer join'],
    ['intoClause', 'SELECT INTO'],
  ] as const) {
    if (hasClause(sel, key)) return { ok: false, blocked: why };
  }
  for (const [key, why] of [
    ['withClause', 'the subquery has its own WITH clause'],
    ['distinctClause', 'the subquery uses DISTINCT'],
    ['groupClause', 'the subquery already groups'],
    ['havingClause', 'the subquery already groups'],
    ['windowClause', 'the subquery uses a window clause'],
    ['sortClause', 'ORDER BY changes nothing under a plain aggregate — and under an ordered-set one it changes everything'],
    ['limitCount', 'LIMIT under an aggregate subquery is a no-op the rewrite should not launder'],
    ['limitOffset', 'OFFSET under an aggregate subquery changes what it returns'],
    ['lockingClause', 'the subquery locks rows'],
  ] as const) {
    if (hasClause(sub, key)) return { ok: false, blocked: why };
  }

  const subTargets = sub['targetList'];
  if (!Array.isArray(subTargets) || subTargets.length !== 1) {
    return { ok: false, blocked: 'the subquery returns more than one column' };
  }
  const val = node(node(subTargets[0])?.['ResTarget'])?.['val'];
  const call = node(node(val)?.['FuncCall']);
  if (!call) return { ok: false, blocked: 'the subquery value is not a bare aggregate call' };
  if (call['agg_filter'] || call['agg_order'] || call['agg_within_group'] || call['over']) {
    return { ok: false, blocked: 'FILTER, WITHIN GROUP and window forms are out of scope for the grouped join' };
  }
  // Only a pg_catalog aggregate: a schema's own `sum`/`count` shares the name
  // but not the empty-group value the rewrite hard-codes, so resolving by name
  // alone would certify the wrong function.
  const aggName = catalogFuncName(call['funcname']);
  if (!aggName || !GROUPABLE_AGGREGATES.has(aggName)) {
    const shown = lastSval(call['funcname']) ?? '?';
    return {
      ok: false,
      blocked: `the grouped join knows the empty-group value for count, sum, min, max and avg — ` +
        `not for \`${shown}\` (and only for the built-in of that name, not a schema's own)`,
    };
  }
  const callArgs = call['args'];
  if (!call['agg_star']) {
    if (!Array.isArray(callArgs) || callArgs.length !== 1 || !columnParts(callArgs[0])) {
      return { ok: false, blocked: 'the aggregate must be over * or a plain column' };
    }
  }

  const subFrom = Array.isArray(sub['fromClause']) ? (sub['fromClause'] as unknown[]) : [];
  const rv = subFrom.length === 1 ? node(node(subFrom[0])?.['RangeVar']) : null;
  if (!rv) return { ok: false, blocked: 'the subquery reads more than one table' };
  const innerRelParts = [rv['schemaname'], rv['relname']].filter(x => typeof x === 'string') as string[];
  const innerName = (node(rv['alias'])?.['aliasname'] as string) ?? (rv['relname'] as string);
  if (!sub['whereClause']) {
    return { ok: false, blocked: 'the subquery is not correlated — Postgres already runs it once, not per row' };
  }

  const outerNames = fromClauseNames(sel['fromClause']);
  if (outerNames.has(innerName)) {
    return {
      ok: false,
      blocked: `the subquery's table is addressed as \`${innerName}\`, which the outer FROM already ` +
        'uses — hoisting it would collide, and re-aliasing would change what the preserved ' +
        'references mean',
    };
  }

  // The derived table is REBUILT, not preserved verbatim, so every reference
  // must be scopable — same discipline as the plain-join path.
  let scopeProblem: string | null = null;
  const scopeCheck = (value: unknown): void => {
    if (scopeProblem) return;
    if (Array.isArray(value)) { for (const v of value) scopeCheck(v); return; }
    const n = node(value);
    if (!n) return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'ColumnRef') {
        const fields = node(v)?.['fields'];
        if (!Array.isArray(fields)) continue;
        if (fields.some(f => node(f)?.['A_Star'] !== undefined)) continue; // count(*) itself
        const parts = fields.map(f => node(node(f)?.['String'])?.['sval']).filter(s => typeof s === 'string') as string[];
        if (parts.length !== fields.length) continue;
        if (parts.length < 2) {
          scopeProblem = `\`${parts[0] ?? '?'}\` is unqualified — which table it belongs to is a catalog ` +
            'question, so qualify every column inside the subquery';
          return;
        }
        const qual = parts.at(-2)!;
        if (qual !== innerName && !outerNames.has(qual)) {
          scopeProblem = `\`${qual}\` names neither the subquery table nor an outer table`;
          return;
        }
      }
      scopeCheck(v);
    }
  };
  scopeCheck(subTargets);
  scopeCheck(sub['whereClause']);
  if (scopeProblem) return { ok: false, blocked: scopeProblem };

  // The aggregate's argument moves into the uncorrelated derived table, where
  // an outer reference no longer resolves — count(o.id) passes the scope check
  // (o is a real outer name) and still cannot be rewritten.
  if (!call['agg_star']) {
    const argParts = columnParts((callArgs as unknown[])[0]);
    if (argParts && argParts.length >= 2 && argParts.at(-2) !== innerName) {
      return {
        ok: false,
        blocked: "the aggregate's argument references the outer query — it cannot move into " +
          'an uncorrelated derived table',
      };
    }
  }

  // Conjunct classification: correlation pins move to GROUP BY + ON and must
  // be plain inner-column = plain outer-column; inner-only residuals stay in
  // the derived table's WHERE; anything else cannot move into an uncorrelated
  // derived table and refuses.
  const whereBool = node(node(sub['whereClause'])?.['BoolExpr']);
  if (whereBool && whereBool['boolop'] !== 'AND_EXPR') {
    return { ok: false, blocked: 'the subquery WHERE is not a plain conjunction' };
  }
  const conjuncts = whereBool && Array.isArray(whereBool['args'])
    ? (whereBool['args'] as unknown[])
    : [sub['whereClause']];

  const refsInner = (v: unknown): boolean => referencesQualifier(v, innerName);
  const refsOuterQual = (v: unknown): boolean =>
    contains(v, (type, n) => {
      if (type !== 'ColumnRef') return false;
      const fields = n['fields'];
      if (!Array.isArray(fields) || fields.length < 2) return false;
      const qual = node(node(fields[fields.length - 2])?.['String'])?.['sval'];
      return typeof qual === 'string' && qual !== innerName && outerNames.has(qual);
    });

  const pins: Array<{ inner: string; outer: string[] }> = [];
  const residualIdx: number[] = [];
  for (let i = 0; i < conjuncts.length; i += 1) {
    const c = conjuncts[i];
    if (!refsOuterQual(c)) { residualIdx.push(i); continue; }
    const ex = node(node(c)?.['A_Expr']);
    if (ex && ex['kind'] === 'AEXPR_OP' && lastSval(ex['name']) === '=') {
      let pinned = false;
      for (const [colSide, otherSide] of [['lexpr', 'rexpr'], ['rexpr', 'lexpr']] as const) {
        const innerParts = columnParts(ex[colSide]);
        const outerParts = columnParts(ex[otherSide]);
        if (innerParts && innerParts.length >= 2 && innerParts.at(-2) === innerName &&
            outerParts && outerParts.length >= 2 && outerParts.at(-2) !== innerName) {
          pins.push({ inner: innerParts.at(-1)!, outer: outerParts });
          pinned = true;
          break;
        }
      }
      if (pinned) continue;
    }
    return {
      ok: false,
      blocked: 'an outer-referencing condition is not a plain column equality — it cannot move ' +
        'into an uncorrelated derived table',
    };
  }
  if (pins.length === 0) {
    return { ok: false, blocked: 'no equality between a subquery column and the outer query — nothing to group by' };
  }

  // The scalar subquery evaluates the residual conjuncts and the aggregate's
  // argument once per (outer row × inner row); the derived table evaluates them
  // once, in one shared grouped pass. For a volatile function — random(),
  // nextval(), clock_timestamp() — that changes the result, and this is the one
  // rewrite path that restructures evaluation (the lateral and plain-join forms
  // preserve it). Volatility is a catalog fact the generator cannot see, so a
  // function anywhere in the residuals or the aggregate argument refuses here.
  // Conservative — an immutable lower() is refused too — but the lateral or
  // plain rewrite still covers those shapes; a wrong grouped join does not.
  const hasFunc = (v: unknown): boolean => contains(v, (type) => type === 'FuncCall');
  if (residualIdx.some((i) => hasFunc(conjuncts[i])) || (!call['agg_star'] && hasFunc(callArgs))) {
    return {
      ok: false,
      blocked: 'a function appears in the subquery filter or the aggregate argument — if it is ' +
        'volatile, evaluating it once per group instead of once per row changes the result, ' +
        'which the grouped join cannot risk',
    };
  }

  const outerFrom = sel['fromClause'];
  if (!Array.isArray(outerFrom) || outerFrom.length !== 1) {
    return {
      ok: false,
      blocked: 'the outer FROM is a comma-separated list — a LEFT JOIN attaches to the last item ' +
        'only, which is not where the correlation may point',
    };
  }

  // ── text assembly ──────────────────────────────────────────────────────────
  const buf = Buffer.from(sql, 'utf8');
  const linkLoc = typeof link['location'] === 'number' ? link['location'] : -1;
  const open = linkLoc >= 0 && buf[linkLoc] === OPEN ? linkLoc : nextOpenParen(buf, Math.max(linkLoc, 0));
  const close = open >= 0 ? matchParen(buf, open) : -1;
  if (close < 0) return { ok: false, blocked: 'could not find the subquery parentheses' };

  const localToks = wordTokens(buf, open + 1, close, 0);
  const whereTok = localToks.find(t => t.depth === 0 && t.upper === 'WHERE');
  if (!whereTok) return { ok: false, blocked: 'could not locate the subquery WHERE keyword' };

  // Verbatim slices: the aggregate call and the inner relation.
  const callLoc = typeof call['location'] === 'number' ? call['location'] : -1;
  const callOpen = callLoc >= 0 ? nextOpenParen(buf, callLoc) : -1;
  const callClose = callOpen >= 0 ? matchParen(buf, callOpen) : -1;
  const relStart = typeof rv['location'] === 'number' ? rv['location'] : -1;
  if (callClose < 0 || relStart < 0) {
    return { ok: false, blocked: 'the parser reported no usable positions inside the subquery' };
  }
  const aggText = buf.subarray(callLoc, callClose + 1).toString('utf8');
  const relText = buf.subarray(relStart, whereTok.start).toString('utf8').trim();

  // Residual conjunct texts, sliced between AND separators like the OR arms.
  const locs = conjuncts.map(minLocation);
  if (locs.some(l => l < 0) || locs.some((l, i) => i > 0 && l <= locs[i - 1])) {
    return { ok: false, blocked: 'the parser reported no usable positions for the WHERE conjuncts' };
  }
  const texts: string[] = [];
  for (let i = 0; i < conjuncts.length; i += 1) {
    let end: number;
    if (i < conjuncts.length - 1) {
      const sep = localToks
        .filter(t => t.upper === 'AND' && t.start >= locs[i] && t.end <= locs[i + 1] &&
                     gapIsOpeners(buf, t.end, locs[i + 1]))
        .at(-1);
      if (!sep) return { ok: false, blocked: 'could not locate the AND separating the conditions' };
      end = sep.start;
    } else {
      end = close;
    }
    const text = stripUnbalancedTail(buf.subarray(locs[i], end).toString('utf8'));
    if (text === null || text.length === 0) {
      return { ok: false, blocked: 'a condition could not be sliced out cleanly' };
    }
    texts.push(text);
  }
  const residualText = residualIdx.map(i => texts[i]).join(' AND ');

  const alias = freshAlias(sql);
  const pinCols = [...new Set(pins.map(p => p.inner))];
  // A pinned column named `agg` would collide with the aggregate's output
  // label inside the derived table, making qn.agg ambiguous at plan time.
  const aggAlias = pinCols.includes('agg') ? freshAlias(sql, 'agg') : 'agg';
  const innerQ = quoteIdent(innerName);
  const pinRefs = pinCols.map(c => `${innerQ}.${quoteIdent(c)}`);
  // Each verbatim slice goes on its own line: a slice that ends in a `--` line
  // comment (`i.qty > 2 -- keep`) would otherwise comment out the generated
  // GROUP BY tail appended after it. The newline terminates any trailing
  // comment before the next clause.
  const derived =
    `(SELECT ${pinRefs.join(', ')}, ${aggText} AS ${aggAlias}\n FROM ${relText}\n` +
    `${residualText ? ` WHERE ${residualText}\n` : ''} GROUP BY ${pinRefs.join(', ')})`;
  const onText = pins
    .map(p => `${quoteIdent(alias)}.${quoteIdent(p.inner)} = ${p.outer.map(quoteIdent).join('.')}`)
    .join(' AND ');
  const replacementExpr = aggName === 'count'
    ? `COALESCE(${quoteIdent(alias)}.${aggAlias}, 0)`
    : `${quoteIdent(alias)}.${aggAlias}`;

  const outerFromStart = minLocation(outerFrom);
  const globalToks = wordTokens(buf);
  const stmtEnd = statementEnd(buf);
  const boundary = globalToks.find(
    t => t.depth === 0 && t.start > outerFromStart && (t.upper === 'WHERE' || CLAUSE_KEYWORDS.has(t.upper)),
  );
  const insertAt = boundary ? boundary.start : stmtEnd;
  if (insertAt <= close) return { ok: false, blocked: 'the outer FROM ends before the subquery — unexpected shape' };

  const joinText = ` LEFT JOIN ${derived} ${quoteIdent(alias)} ON ${onText} `;
  const rewritten = (
    buf.subarray(0, open).toString('utf8') +
    replacementExpr +
    buf.subarray(close + 1, insertAt).toString('utf8') +
    joinText +
    buf.subarray(insertAt).toString('utf8')
  ).trimEnd();

  // Expected tree: derived-table SelectStmt built node by node from reused
  // subtrees; the COALESCE wrapper; the flat AND of pin equalities.
  const colRef = (...parts: string[]): Node => ({
    ColumnRef: { fields: parts.map(s => ({ String: { sval: s } })) },
  });
  const derivedSelect: Node = {
    targetList: [
      ...pinCols.map(c => ({ ResTarget: { val: colRef(innerName, c) } })),
      { ResTarget: { name: aggAlias, val: clone(val) } },
    ],
    fromClause: [clone(subFrom[0])],
    groupClause: pinCols.map(c => colRef(innerName, c)),
    limitOption: 'LIMIT_OPTION_DEFAULT',
    op: 'SETOP_NONE',
  };
  // Reparsing flattens `(a AND b) AND c` to a single AND of [a,b,c], so the
  // expected tree must flatten every nested AND in the residuals to match —
  // otherwise an ordinary parenthesised residual is validated against a nested
  // shape it never reparses to, and a valid candidate is silently withheld.
  const flattenAnd = (n: unknown): unknown[] => {
    const b = node(node(n)?.['BoolExpr']);
    return b && b['boolop'] === 'AND_EXPR' && Array.isArray(b['args'])
      ? (b['args'] as unknown[]).flatMap(flattenAnd)
      : [n];
  };
  const residualLeaves = residualIdx.flatMap(i => flattenAnd(conjuncts[i])).map(clone);
  if (residualLeaves.length === 1) derivedSelect['whereClause'] = residualLeaves[0];
  else if (residualLeaves.length > 1) {
    derivedSelect['whereClause'] = { BoolExpr: { boolop: 'AND_EXPR', args: residualLeaves } };
  }
  const pinQuals = pins.map(p => ({
    A_Expr: {
      kind: 'AEXPR_OP', name: [{ String: { sval: '=' } }],
      lexpr: colRef(alias, p.inner), rexpr: colRef(...p.outer),
    },
  }));
  const quals = pinQuals.length === 1
    ? pinQuals[0]
    : { BoolExpr: { boolop: 'AND_EXPR', args: pinQuals } };

  const expected = clone(sel);
  (node(node((expected['targetList'] as unknown[])[targetIndex])?.['ResTarget']) as Node)['val'] =
    aggName === 'count'
      ? { CoalesceExpr: { args: [colRef(alias, aggAlias), { A_Const: { ival: {} } }] } }
      : colRef(alias, aggAlias);
  expected['fromClause'] = [{
    JoinExpr: {
      jointype: 'JOIN_LEFT',
      larg: clone(outerFrom[0]),
      rarg: { RangeSubselect: { subquery: { SelectStmt: derivedSelect }, alias: { aliasname: alias } } },
      quals,
    },
  }];

  const problem = validateReconstruction(rewritten, { SelectStmt: expected });
  if (problem) return { ok: false, blocked: problem };

  return {
    ok: true,
    candidate: {
      kind: 'correlated-subquery-in-select',
      sql: rewritten,
      byteSpan: { start: open, end: close + 1 },
      charSpan: { start: byteToCharIndex(sql, open), end: byteToCharIndex(sql, close + 1) },
      replaced: buf.subarray(open, close + 1).toString('utf8'),
      replacement: replacementExpr,
      preconditions: [{
        kind: 'function-is-aggregate',
        functions: [aggName],
        why: 'The grouped form only computes the same thing if this call aggregates its group; ' +
             'an ordinary function of the same name would make the two forms mean different things.',
      }],
      rationale:
        'One grouped pass over the inner table instead of an aggregate subplan per outer row — ' +
        'the planner can hash it. The derived table has at most one row per key by construction, ' +
        `so the join cannot fan out${aggName === 'count' ? '; COALESCE restores count()’s 0 on no match where the join produces NULL' : ''}.`,
    },
  };
}

// ── transform: correlated scalar subquery in SELECT → LEFT JOIN ──────────────

/**
 * `SELECT …, (SELECT expr FROM inner i WHERE i.k = outer.k) FROM …`
 *   → `SELECT …, expr FROM … LEFT JOIN inner i ON i.k = outer.k`.
 *
 * The join preserves the subquery's NULL-on-no-match; what it cannot preserve
 * unaided is the *at most one match* the scalar subquery enforced by raising
 * an error. A unique index whose key columns are a subset of the equality-
 * pinned columns makes a second match impossible — that is the precondition,
 * and it is checked against pg_index before anything executes.
 *
 * The subquery's own alias is kept verbatim, so every reference inside the
 * hoisted WHERE keeps its meaning; a collision with an outer name refuses
 * rather than re-aliasing, because rewriting references is how scope capture
 * happens.
 */
export function generateCorrelatedSelect(sql: string, sel: Node, link: Node): CandidateResult {
  if (inputStatementCount(sql) !== 1) {
    return { ok: false, blocked: 'the input contains more than one statement' };
  }
  if (sel['op'] !== 'SETOP_NONE') {
    return { ok: false, blocked: 'the statement is a set operation' };
  }
  for (const [key, why] of [
    ['groupClause', 'the outer query groups — the joined value would itself need grouping'],
    ['havingClause', 'the outer query groups — the joined value would itself need grouping'],
    ['lockingClause', 'FOR UPDATE cannot lock the nullable side of an outer join'],
    ['intoClause', 'SELECT INTO'],
  ] as const) {
    if (hasClause(sel, key)) return { ok: false, blocked: why };
  }

  const targets = Array.isArray(sel['targetList']) ? (sel['targetList'] as unknown[]) : [];
  const targetIndex = targets.findIndex(t => node(node(node(t)?.['ResTarget'])?.['val'])?.['SubLink'] === link);
  if (targetIndex < 0) {
    return {
      ok: false,
      blocked: 'the subquery is nested inside an expression — only a subquery that is itself ' +
        'a select-list entry is rewritten',
    };
  }

  const sub = node(node(link['subselect'])?.['SelectStmt']);
  if (!sub) return { ok: false, blocked: 'the subquery is not a plain SELECT' };
  if (sub['op'] !== 'SETOP_NONE') return { ok: false, blocked: 'the subquery is a set operation' };

  // Route the specialised shapes before the plain-join guards refuse them:
  // ORDER BY + LIMIT 1 is the top-1-per-key idiom (the lateral generator),
  // and a bare aggregate call is the grouped-join shape. Everything else
  // falls through to the plain join below.
  if (hasClause(sub, 'sortClause') && isLiteralOne(sub['limitCount']) && !hasClause(sub, 'limitOffset')) {
    return generateLateralTop1(sql, sel, link, sub, targetIndex);
  }
  const subVal = node(node(node((Array.isArray(sub['targetList']) ? sub['targetList'][0] : null) as Node | null)?.['ResTarget'])?.['val']);
  const subCall = node(subVal?.['FuncCall']);
  const subCallName = subCall ? (lastSval(subCall['funcname'])?.toLowerCase() ?? null) : null;
  if (subCall && (subCall['agg_star'] || subCall['agg_distinct'] ||
                  (subCallName !== null && GROUPABLE_AGGREGATES.has(subCallName)))) {
    return generateGroupedJoin(sql, sel, link, sub, targetIndex);
  }

  for (const [key, why] of [
    ['withClause', 'the subquery has its own WITH clause'],
    ['distinctClause', 'the subquery uses DISTINCT'],
    ['groupClause', 'the subquery aggregates — the grouped-join rewrite for that is not generated'],
    ['havingClause', 'the subquery aggregates — the grouped-join rewrite for that is not generated'],
    ['windowClause', 'the subquery uses a window clause'],
    ['sortClause', 'ORDER BY in a scalar subquery pairs with LIMIT to pick one row per outer row — ' +
                   'that is a lateral-join pattern, out of scope for a plain join'],
    ['limitCount', 'LIMIT in a scalar subquery is either a no-op or a per-row top-1 — ' +
                   'which one was meant cannot be told from the tree'],
    ['limitOffset', 'OFFSET in a scalar subquery changes which row is returned'],
    ['lockingClause', 'the subquery locks rows'],
  ] as const) {
    if (hasClause(sub, key)) return { ok: false, blocked: why };
  }

  const subFrom = sub['fromClause'];
  if (!Array.isArray(subFrom) || subFrom.length !== 1) {
    return { ok: false, blocked: 'the subquery reads more than one table' };
  }
  const rv = node(node(subFrom[0])?.['RangeVar']);
  if (!rv) return { ok: false, blocked: 'the subquery does not read a plain table' };
  const innerRelParts = [rv['schemaname'], rv['relname']].filter(x => typeof x === 'string') as string[];
  const innerName = (node(rv['alias'])?.['aliasname'] as string) ?? (rv['relname'] as string);

  const subTargets = sub['targetList'];
  if (!Array.isArray(subTargets) || subTargets.length !== 1) {
    return { ok: false, blocked: 'the subquery returns more than one column' };
  }
  const val = node(node(subTargets[0])?.['ResTarget'])?.['val'];
  if (!val) return { ok: false, blocked: 'the subquery selects nothing usable' };
  if (contains(val, type => type === 'SubLink')) {
    return { ok: false, blocked: 'the subquery nests another subquery in its select list' };
  }
  const use = functionUse(val);
  if (use.refused === 'an aggregate call') {
    // The grouped-join generator handles a BARE aggregate call as the whole
    // select value; this path is reached only for an aggregate wrapped in an
    // expression (`count(*) + 1`) or a non-groupable one (`array_agg`), where
    // the empty-group value is not a single known constant.
    return {
      ok: false,
      blocked: 'the subquery aggregates inside an expression, or with an aggregate the grouped ' +
        'join does not cover — only a bare count/sum/min/max/avg call is rewritten',
    };
  }
  if (use.refused) {
    return { ok: false, blocked: `the subquery's select list contains ${use.refused}` };
  }

  if (!sub['whereClause']) {
    return {
      ok: false,
      blocked: 'the subquery is not correlated — Postgres already runs it once, not per row',
    };
  }

  const outerNames = fromClauseNames(sel['fromClause']);
  if (outerNames.has(innerName)) {
    return {
      ok: false,
      blocked: `the subquery's table is addressed as \`${innerName}\`, which the outer FROM already ` +
        'uses — hoisting it would collide, and re-aliasing would change what the preserved ' +
        'references mean',
    };
  }

  // Every column reference inside the subquery must be qualified, and the
  // qualifier must be scopable: the inner table or a real outer name. An
  // unqualified name binds by catalog lookup, which generation does not have.
  let scopeProblem: string | null = null;
  const scopeCheck = (value: unknown): void => {
    if (scopeProblem) return;
    if (Array.isArray(value)) { for (const v of value) scopeCheck(v); return; }
    const n = node(value);
    if (!n) return;
    for (const [k, v] of Object.entries(n)) {
      if (k === 'ColumnRef') {
        const cr = node(v);
        const fields = cr?.['fields'];
        if (!Array.isArray(fields)) continue;
        if (fields.some(f => node(f)?.['A_Star'] !== undefined)) {
          scopeProblem = 'the subquery uses `*`';
          return;
        }
        const parts = fields.map(f => node(node(f)?.['String'])?.['sval']).filter(s => typeof s === 'string') as string[];
        if (parts.length !== fields.length) continue;
        if (parts.length < 2) {
          scopeProblem = `\`${parts[0] ?? '?'}\` is unqualified — which table it belongs to is a catalog ` +
            'question, so qualify every column inside the subquery';
          return;
        }
        const qual = parts.at(-2)!;
        if (qual !== innerName && !outerNames.has(qual)) {
          scopeProblem = `\`${qual}\` names neither the subquery table nor an outer table`;
          return;
        }
      }
      scopeCheck(v);
    }
  };
  scopeCheck(subTargets);
  scopeCheck(sub['whereClause']);
  if (scopeProblem) return { ok: false, blocked: scopeProblem };

  const refsInner = (v: unknown): boolean => referencesQualifier(v, innerName);
  const refsOuter = (v: unknown): boolean =>
    contains(v, (type, n) => {
      if (type !== 'ColumnRef') return false;
      const fields = n['fields'];
      if (!Array.isArray(fields) || fields.length < 2) return false;
      const qual = node(node(fields[fields.length - 2])?.['String'])?.['sval'];
      return typeof qual === 'string' && outerNames.has(qual);
    });
  if (!refsOuter(sub['whereClause'])) {
    return {
      ok: false,
      blocked: 'the subquery is not correlated — Postgres already runs it once, not per row',
    };
  }

  // Equality-pinned inner columns: `inner.col = <no inner references>`. These
  // are what a unique index must cover for the join to be fan-out-free.
  const whereBool = node(node(sub['whereClause'])?.['BoolExpr']);
  const conjuncts = whereBool && whereBool['boolop'] === 'AND_EXPR' && Array.isArray(whereBool['args'])
    ? (whereBool['args'] as unknown[])
    : [sub['whereClause']];
  const pinned = new Set<string>();
  for (const c of conjuncts) {
    const ex = node(node(c)?.['A_Expr']);
    if (!ex || ex['kind'] !== 'AEXPR_OP') continue;
    const op = Array.isArray(ex['name']) && ex['name'].length === 1
      ? node(node((ex['name'] as unknown[])[0])?.['String'])?.['sval']
      : null;
    if (op !== '=') continue;
    for (const [colSide, otherSide] of [['lexpr', 'rexpr'], ['rexpr', 'lexpr']] as const) {
      const parts = columnParts(ex[colSide]);
      if (parts && parts.length >= 2 && parts.at(-2) === innerName && !refsInner(ex[otherSide])) {
        pinned.add(parts.at(-1)!);
      }
    }
  }
  if (pinned.size === 0) {
    return {
      ok: false,
      blocked: 'no conjunct pins a subquery column with `=` against the outer row — without one, ' +
        'no unique index can bound the join to a single match',
    };
  }

  const outerFrom = sel['fromClause'];
  if (!Array.isArray(outerFrom) || outerFrom.length !== 1) {
    return {
      ok: false,
      blocked: 'the outer FROM is a comma-separated list — a LEFT JOIN attaches to the last item ' +
        'only, which is not where the correlation may point',
    };
  }

  // ── text assembly: two edits, both verbatim slices of the original ─────────
  const buf = Buffer.from(sql, 'utf8');
  const linkLoc = typeof link['location'] === 'number' ? link['location'] : -1;
  if (linkLoc < 0) return { ok: false, blocked: 'the parser reported no position for the subquery' };
  const open = buf[linkLoc] === OPEN ? linkLoc : nextOpenParen(buf, linkLoc);
  const close = open >= 0 ? matchParen(buf, open) : -1;
  if (close < 0) return { ok: false, blocked: 'could not find the subquery parentheses' };

  const localToks = wordTokens(buf, open + 1, close, 0);
  const fromTok = localToks.find(t => t.depth === 0 && t.upper === 'FROM');
  const whereTok = localToks.find(t => t.depth === 0 && t.upper === 'WHERE');
  if (!fromTok || !whereTok) return { ok: false, blocked: 'could not locate the subquery FROM/WHERE keywords' };

  const valStart = minLocation(val);
  const relStart = typeof rv['location'] === 'number' ? rv['location'] : -1;
  const onStart = minLocation(sub['whereClause']);
  if (valStart < 0 || relStart < 0 || onStart < 0) {
    return { ok: false, blocked: 'the parser reported no usable positions inside the subquery' };
  }

  const exprText = stripUnbalancedTail(buf.subarray(valStart, fromTok.start).toString('utf8'));
  const relText = buf.subarray(relStart, whereTok.start).toString('utf8').trim();
  const onText = stripUnbalancedTail(buf.subarray(onStart, close).toString('utf8'));
  if (!exprText || !relText || !onText) {
    return { ok: false, blocked: 'the subquery text could not be sliced out cleanly' };
  }

  const outerFromStart = minLocation(outerFrom);
  const globalToks = wordTokens(buf);
  const stmtEnd = statementEnd(buf);
  const boundary = globalToks.find(
    t => t.depth === 0 && t.start > outerFromStart && (t.upper === 'WHERE' || CLAUSE_KEYWORDS.has(t.upper)),
  );
  const insertAt = boundary ? boundary.start : stmtEnd;
  if (insertAt <= close) return { ok: false, blocked: 'the outer FROM ends before the subquery — unexpected shape' };

  const joinText = ` LEFT JOIN ${relText} ON ${onText} `;
  const rewritten = (
    buf.subarray(0, open).toString('utf8') +
    exprText +
    buf.subarray(close + 1, insertAt).toString('utf8') +
    joinText +
    buf.subarray(insertAt).toString('utf8')
  ).trimEnd();

  // Expected tree: same statement with the value expression hoisted into the
  // select list and the FROM replaced by a left join whose qual is the
  // subquery's WHERE, all subtrees reused from the original parse.
  const expected = clone(sel);
  const expectedTargets = expected['targetList'] as unknown[];
  (node(node(expectedTargets[targetIndex])?.['ResTarget']) as Node)['val'] = clone(val);
  expected['fromClause'] = [{
    JoinExpr: {
      jointype: 'JOIN_LEFT',
      larg: clone(outerFrom[0]),
      rarg: clone(subFrom[0]),
      quals: clone(sub['whereClause']),
    },
  }];

  const problem = validateReconstruction(rewritten, { SelectStmt: expected });
  if (problem) return { ok: false, blocked: problem };

  const preconditions: PreconditionSpec[] = [{
    kind: 'unique-key-covers',
    relation: innerRelParts,
    columns: [...pinned].sort(),
    why: 'The scalar subquery raised an error on a second matching row; the join would silently ' +
         'duplicate the outer row instead. A unique index over the equality columns makes a ' +
         'second match impossible.',
  }];
  if (use.names.length > 0) {
    preconditions.push({
      kind: 'function-not-aggregate',
      functions: use.names,
      why: 'An aggregate in the subquery returns a value even when no row matches — 0, not NULL — ' +
           'which a plain join cannot reproduce.',
    });
  }

  return {
    ok: true,
    candidate: {
      kind: 'correlated-subquery-in-select',
      sql: rewritten,
      byteSpan: { start: open, end: close + 1 },
      charSpan: { start: byteToCharIndex(sql, open), end: byteToCharIndex(sql, close + 1) },
      replaced: buf.subarray(open, close + 1).toString('utf8'),
      replacement: exprText,
      preconditions,
      rationale:
        'A join is evaluated once as a set — the planner can hash or merge it — instead of the ' +
        'subquery running once per output row. LEFT JOIN keeps the NULL where nothing matches.',
    },
  };
}

// ── pairing candidates with findings ─────────────────────────────────────────

export interface CandidateSite {
  kind: GeneratedRewriteKind;
  /** The byte offset the corresponding finding carries, for pairing. */
  location: number | null;
  result: CandidateResult;
}

const lastSval = (arr: unknown): string | null => {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const s = node(node(arr[arr.length - 1])?.['String'])?.['sval'];
  return typeof s === 'string' ? s : null;
};

/**
 * The function's name ONLY when it resolves to pg_catalog — unqualified, or
 * schema-qualified `pg_catalog.name`. A `myschema.sum(...)` returns null.
 *
 * Matching a builtin by last name-part alone is a real hazard: a user aggregate
 * `app.sum` shares a name with `pg_catalog.sum` but has its own empty-group
 * value, so treating it as the builtin certifies the wrong semantics. The
 * date() rewrite already guards this way; the aggregate generators must too.
 */
const catalogFuncName = (funcname: unknown): string | null => {
  if (!Array.isArray(funcname) || funcname.length === 0 || funcname.length > 2) return null;
  const last = node(node(funcname.at(-1))?.['String'])?.['sval'];
  const schema = funcname.length === 2 ? node(node(funcname[0])?.['String'])?.['sval'] : 'pg_catalog';
  return typeof last === 'string' && schema === 'pg_catalog' ? last.toLowerCase() : null;
};

const loc = (n: Node): number | null => (typeof n['location'] === 'number' ? n['location'] : null);

/**
 * A LIMIT that is the literal 1, however spelled — `1`, `'1'::int`, `1.0` —
 * so the top-1 idiom is recognised whether or not the author wrote a bare
 * integer. Peels one TypeCast (that is how `'1'::int` parses). A parameter or
 * an expression is deliberately not one: those fall to the plain path, which
 * refuses honestly rather than guessing the limit is 1.
 */
const isLiteralOne = (limitCount: unknown): boolean => {
  const inner = node(node(limitCount)?.['TypeCast'])?.['arg'] ?? limitCount;
  const c = node(node(inner)?.['A_Const']);
  if (!c) return false;
  if (node(c['ival'])?.['ival'] === 1) return true;
  const sval = node(c['sval'])?.['sval'];
  const fval = node(c['fval'])?.['fval'];
  return sval === '1' || fval === '1' || fval === '1.0';
};

/**
 * Find every Tier A site in one statement and run its generator.
 *
 * Sites are keyed by the same byte offset the advisor's findings carry, so the
 * two can be paired without re-detecting anything. Scope matters: the
 * generators resolve column references against the statement's own FROM
 * clause, which is only correct for predicates in the statement's own scope.
 * A pattern inside a nested subquery gets a blocked marker instead of a wrong
 * candidate, and a non-SELECT statement blocks everything.
 */
export function generateCandidates(sql: string, stmtContent: Node): CandidateSite[] {
  const sites: CandidateSite[] = [];
  const sel = node(stmtContent['SelectStmt']);

  const emit = (
    kind: GeneratedRewriteKind,
    location: number | null,
    topScope: boolean,
    make: () => CandidateResult,
  ): void => {
    let result: CandidateResult;
    if (!sel) {
      result = { ok: false, blocked: 'generated rewrites cover SELECT statements — apply the same change here by hand' };
    } else if (!topScope) {
      result = { ok: false, blocked: 'this sits inside a nested subquery — analyse that subquery on its own to get a generated rewrite' };
    } else {
      result = make();
    }
    sites.push({ kind, location, result });
  };

  const visit = (value: unknown, topScope: boolean): void => {
    if (Array.isArray(value)) {
      for (const v of value) visit(v, topScope);
      return;
    }
    const n = node(value);
    if (!n) return;
    for (const [key, v] of Object.entries(n)) {
      const child = node(v);
      if (child) {
        if (key === 'BoolExpr' && child['boolop'] === 'OR_EXPR') {
          emit('or-across-columns', loc(child), topScope, () => generateOrSplit(sql, sel!, child));
        }
        if (key === 'SubLink' && child['subLinkType'] === 'EXPR_SUBLINK' && child['subselect']) {
          emit('correlated-subquery-in-select', loc(child), topScope, () => generateCorrelatedSelect(sql, sel!, child));
        }
        if (key === 'BoolExpr' && child['boolop'] === 'NOT_EXPR' && Array.isArray(child['args'])) {
          // `x NOT IN (SELECT …)` parses as NOT over ANY_SUBLINK.
          for (const arg of child['args'] as unknown[]) {
            const link = node(node(arg)?.['SubLink']);
            if (link && link['subLinkType'] === 'ANY_SUBLINK' && link['subselect']) {
              emit('not-in-subquery', loc(link), topScope, () => generateNotInSubquery(sql, sel!, link));
            }
          }
        }
        if (key === 'SubLink' && child['subLinkType'] === 'ALL_SUBLINK' &&
            child['subselect'] && lastSval(child['operName']) === '<>') {
          // The explicitly-spelled `x <> ALL (SELECT …)` form of the same thing.
          emit('not-in-subquery', loc(child), topScope, () => generateNotInSubquery(sql, sel!, child));
        }
        if (key === 'A_Expr' && child['kind'] === 'AEXPR_IN' && lastSval(child['name']) === '<>') {
          emit('not-in-list', loc(child), topScope, () => generateNotInList(sql, sel!, child));
        }
        if (key === 'A_Expr' && child['kind'] === 'AEXPR_OP') {
          // The finding is keyed to the FuncCall's own offset, one per side.
          for (const side of ['lexpr', 'rexpr'] as const) {
            const call = node(node(child[side])?.['FuncCall']);
            if (call) emit('function-on-column', loc(call), topScope, () => generateFunctionOnColumn(sql, sel!, child));
          }
        }
        visit(v, key === 'SelectStmt' && child !== sel ? false : topScope);
      } else {
        visit(v, topScope);
      }
    }
  };

  visit(stmtContent, true);
  return sites;
}
