/**
 * Column extraction from Postgres predicate text.
 *
 * A deliberate heuristic, not a parser. Postgres prints predicates as
 * deparsed expressions — `((status)::text = 'pending'::text)` — and we pull
 * column references out with regex.
 *
 * This is honest for one reason: extracted columns become *hypotheses*, and the
 * what-if engine tests them by re-planning against a hypothetical index. A wrong
 * guess produces a suggestion that visibly fails to change the plan, rather than
 * bad advice that ships. Confidence is reported alongside every result so the UI
 * never presents a guess as a certainty.
 *
 * For the rewrite advisor (REQUIREMENTS.md F4) this gets replaced by libpg_query
 * against the original SQL, which is the real parser. That work operates on the
 * query text; this operates on plan output, where no AST is available.
 */

export type PredicateOp = 'eq' | 'range' | 'pattern' | 'membership' | 'null' | 'other';

export interface ExtractedColumn {
  name: string;
  op: PredicateOp;
  /** Set when the column is wrapped in a function call, e.g. `date(created_at)`. */
  wrappedIn: string | null;
  /** Set when Postgres had to cast the column before comparing. */
  castTo: string | null;
}

/**
 * Keywords that look like identifiers but are never *columns*. Includes type
 * names, because `'x'::date` would otherwise read as a column called `date`.
 */
const RESERVED = new Set([
  'and', 'or', 'not', 'is', 'null', 'true', 'false', 'any', 'all', 'in', 'like',
  'ilike', 'between', 'case', 'when', 'then', 'else', 'end', 'text', 'integer',
  'bigint', 'numeric', 'boolean', 'date', 'timestamp', 'timestamptz', 'interval',
  'character', 'varying', 'double', 'precision', 'real', 'smallint', 'uuid',
  'jsonb', 'json', 'array', 'now', 'current_date', 'current_timestamp',
]);

/**
 * Tokens that can precede a `(` without being a function call.
 *
 * Deliberately NOT the RESERVED list above. Type names overlap with function
 * names — `date` is both — and conflating the two silently suppressed the
 * function-wrapper warning for `WHERE date(created_at) = ...`, which is the
 * single most common index-defeating predicate there is. A cast is never
 * followed by `(`, so type names do not belong here.
 */
const NON_FUNCTION_KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'any', 'all', 'case', 'when', 'then', 'else',
  'exists', 'is', 'between',
]);

/**
 * Functions that appear wrapped around columns but don't defeat an index,
 * because Postgres can still use the underlying column. Kept small and
 * conservative — being wrong here means suppressing a real warning.
 */
const INDEX_SAFE_WRAPPERS = new Set<string>([]);

function stripLiterals(text: string): string {
  // Remove single-quoted literals (including '' escapes) so their contents
  // never get mistaken for identifiers.
  return text.replace(/'(?:[^']|'')*'/g, "''");
}

function classifyOp(op: string): PredicateOp {
  const o = op.trim().toLowerCase();
  if (o === '=') return 'eq';
  if (o === '<' || o === '>' || o === '<=' || o === '>=') return 'range';
  if (o === '~~' || o === '!~~' || o === '~~*' || o === '!~~*' || o === '~' || o === '!~') {
    return 'pattern';
  }
  if (o === '<>' || o === '!=') return 'other';
  if (o === '= any' || o === 'in') return 'membership';
  return 'other';
}

/**
 * Pull column references out of a predicate string.
 *
 * Handles the shapes Postgres actually emits:
 *   (customer_id = 42)
 *   ((status)::text = 'pending'::text)
 *   (date(created_at) = '2024-01-01'::date)
 *   ((created_at >= '...') AND (created_at < '...'))
 *   (id = ANY ('{1,2,3}'::integer[]))
 */
export function extractColumns(predicate: string | null): ExtractedColumn[] {
  if (!predicate) return [];
  const text = stripLiterals(predicate);
  const found = new Map<string, ExtractedColumn>();

  // Column, optionally parenthesised and/or cast, followed by an operator.
  //   group 1: function wrapper, if any
  //   group 2: column name
  //   group 3: cast target, if any
  //   group 4: operator
  const pattern =
    /(?:([a-z_][a-z0-9_]*)\s*\(\s*)?\(?\b([a-z_][a-z0-9_]*)\b\)?(?:::([a-z_][a-z0-9_ ]*))?\s*\)?\s*(=\s*ANY|<=|>=|<>|!=|~~\*?|!~~\*?|=|<|>|~|!~)/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [, wrapper, rawName, cast, op] = match;
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    if (RESERVED.has(name)) continue;

    // `AND (col = 1)` puts a keyword immediately before a paren; that is not a
    // function call. Type names are deliberately allowed through — see the note
    // on NON_FUNCTION_KEYWORDS.
    const wrapperName =
      wrapper && !NON_FUNCTION_KEYWORDS.has(wrapper.toLowerCase()) ? wrapper : null;

    const entry: ExtractedColumn = {
      name,
      op: classifyOp(op ?? ''),
      wrappedIn: wrapperName && !INDEX_SAFE_WRAPPERS.has(wrapperName) ? wrapperName : null,
      castTo: cast ? cast.trim() : null,
    };

    // Equality beats range beats everything else: if a column appears twice,
    // keep the most selective usage, since that drives index column ordering.
    const existing = found.get(name);
    if (!existing || rank(entry.op) > rank(existing.op)) {
      found.set(name, entry);
    }
  }

  return [...found.values()];
}

function rank(op: PredicateOp): number {
  switch (op) {
    case 'eq':
      return 4;
    case 'membership':
      return 3;
    case 'range':
      return 2;
    case 'pattern':
      return 1;
    default:
      return 0;
  }
}

/**
 * Order columns for a composite b-tree index.
 *
 * Equality columns first, then range columns. This is the rule that actually
 * matters: an index on (range_col, eq_col) can only use the first column for a
 * scan boundary, while (eq_col, range_col) uses both. Getting the order wrong
 * produces an index Postgres will half-ignore.
 */
export function orderForIndex(columns: ExtractedColumn[]): ExtractedColumn[] {
  const usable = columns.filter((c) => c.op !== 'other');
  const equality = usable.filter((c) => c.op === 'eq' || c.op === 'membership');
  const ranges = usable.filter((c) => c.op === 'range');
  const patterns = usable.filter((c) => c.op === 'pattern');
  // Only the leading range column can act as a scan boundary, so there is no
  // value in trailing range columns — keep one.
  return [...equality, ...ranges.slice(0, 1), ...patterns.slice(0, equality.length > 0 ? 0 : 1)];
}

/** Quote an identifier only when Postgres would need it quoted. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
