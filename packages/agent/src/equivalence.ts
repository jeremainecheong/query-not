/**
 * Row-level equivalence: do the original and the rewritten query return the
 * same rows on the current data?
 *
 * The comparison is one single statement, which makes snapshot consistency
 * automatic — READ COMMITTED takes a new snapshot per statement, so running
 * the two forms as separate statements could legitimately see different data
 * mid-flight and manufacture a false mismatch. `EXCEPT ALL` gives multiset
 * semantics (a rewrite that accidentally deduplicates must fail) and compares
 * NULLs as equal, which is what row identity wants.
 *
 * The guard refuses cases where a row-level claim would be unsound however
 * carefully it was executed:
 *
 *   - LIMIT/OFFSET: which rows exist depends on tie-breaking, the rewrite
 *     changes the plan, and the plan is the tie-breaker. Even the same query
 *     twice can differ. The re-plan proof stands; row verification does not
 *     apply.
 *   - volatile functions: two evaluations are two different values.
 *
 * Everything here is pure; execution lives in the orchestrator.
 */

export interface EquivalenceResult {
  status: 'match' | 'mismatch' | 'not-checkable' | 'too-many-rows';
  rowsOriginal: number | null;
  rowsRewritten: number | null;
  onlyInOriginal: number | null;
  onlyInRewritten: number | null;
  /** 'text' when the row type had no equality operator and rows were compared as text. */
  comparedAs: 'native' | 'text' | null;
  /** What was compared and what that does and does not prove. */
  note: string;
}

type Node = Record<string, unknown>;
const node = (v: unknown): Node | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : null;

/** Every function name (last path segment) called anywhere in the tree. */
export function harvestFunctionNames(tree: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const n = node(v);
    if (!n) return;
    for (const [k, val] of Object.entries(n)) {
      if (k === 'FuncCall') {
        const parts = node(val)?.['funcname'];
        if (Array.isArray(parts) && parts.length > 0) {
          const s = node(node(parts[parts.length - 1])?.['String'])?.['sval'];
          if (typeof s === 'string') out.add(s);
        }
      }
      visit(val);
    }
  };
  visit(tree);
  return [...out].sort();
}

/**
 * Is a row-level comparison of this statement sound at all?
 *
 * Takes the parse tree of the ORIGINAL statement and the set of its function
 * names Postgres reports volatile. Refusal reasons are user-facing sentences.
 */
export function equivalenceGuard(
  tree: unknown,
  volatileFunctions: Set<string>,
): { checkable: true } | { checkable: false; reason: string } {
  const stmts = (node(tree)?.['stmts'] as unknown[]) ?? [];
  const sel = node(node(node(stmts[0])?.['stmt'])?.['SelectStmt']);
  if (!sel) return { checkable: false, reason: 'row comparison covers SELECT statements only' };

  if (sel['limitCount'] || sel['limitOffset']) {
    return {
      checkable: false,
      reason:
        'the query has LIMIT or OFFSET, so which rows it returns depends on tie-breaking — ' +
        'and the rewrite changes the plan, which is the tie-breaker. The re-plan proof stands; ' +
        'row-level verification does not apply',
    };
  }

  const volatile = harvestFunctionNames(tree).filter((f) => volatileFunctions.has(f));
  if (volatile.length > 0) {
    return {
      checkable: false,
      reason:
        `the query calls ${volatile.map((f) => `${f}()`).join(', ')}, which ${volatile.length === 1 ? 'is' : 'are'} ` +
        'volatile — two evaluations are two different results, so a row comparison proves nothing',
    };
  }
  return { checkable: true };
}

/** An identifier prefix that appears nowhere in either statement. */
export function freshPrefix(a: string, b: string, base = 'qn'): string {
  let p = base;
  const text = a + '\n' + b;
  while (new RegExp(`\\b${p}_`, 'i').test(text)) p += 'q';
  return p;
}

export interface ComparisonSpec {
  text: string;
  /** Row cap; either side reaching cap+1 means the check refuses honestly. */
  cap: number;
  prefix: string;
}

/**
 * The single comparison statement.
 *
 * Both inputs must already have passed `admitQuery` — they are embedded as
 * subqueries, and the wrapper is agent-built scaffolding around two
 * individually admitted texts. CTEs referenced twice are materialised by
 * Postgres itself, so each side executes exactly once.
 */
export function buildComparisonSql(
  originalSql: string,
  rewrittenSql: string,
  opts: { cap?: number; asText?: boolean } = {},
): ComparisonSpec {
  const cap = opts.cap ?? 100_000;
  const strip = (s: string): string => s.trim().replace(/;+\s*$/, '');
  const a = strip(originalSql);
  const b = strip(rewrittenSql);
  const p = freshPrefix(a, b);

  // The text fallback exists for row types with no equality operator (json,
  // xml, point): EXCEPT ALL over them raises 42883, and comparing the rows'
  // text form is the honest second-best — said out loud via comparedAs.
  const lhs = opts.asText ? `${p}_at` : `${p}_a`;
  const rhs = opts.asText ? `${p}_bt` : `${p}_b`;
  const textCtes = opts.asText
    ? `,
       ${p}_at AS (SELECT (t.*)::text AS r FROM ${p}_a t),
       ${p}_bt AS (SELECT (t.*)::text AS r FROM ${p}_b t)`
    : '';

  return {
    cap,
    prefix: p,
    text: `
      WITH ${p}_a AS (SELECT * FROM (${a}) ${p}_orig LIMIT ${cap + 1}),
           ${p}_b AS (SELECT * FROM (${b}) ${p}_rw LIMIT ${cap + 1})${textCtes}
      SELECT (SELECT count(*) FROM ${p}_a)                                          AS a_rows,
             (SELECT count(*) FROM ${p}_b)                                          AS b_rows,
             (SELECT count(*) FROM ((TABLE ${lhs}) EXCEPT ALL (TABLE ${rhs})) d1)   AS only_in_a,
             (SELECT count(*) FROM ((TABLE ${rhs}) EXCEPT ALL (TABLE ${lhs})) d2)   AS only_in_b
    `,
  };
}

/** The counts row, as the driver returns it (bigints arrive as strings). */
export interface ComparisonRow {
  a_rows: string | number;
  b_rows: string | number;
  only_in_a: string | number;
  only_in_b: string | number;
}

export function interpretComparison(
  row: ComparisonRow,
  cap: number,
  comparedAs: 'native' | 'text',
): EquivalenceResult {
  const n = (v: string | number): number => Number(v);
  const aRows = n(row.a_rows);
  const bRows = n(row.b_rows);

  if (aRows > cap || bRows > cap) {
    return {
      status: 'too-many-rows',
      rowsOriginal: aRows > cap ? null : aRows,
      rowsRewritten: bRows > cap ? null : bRows,
      onlyInOriginal: null,
      onlyInRewritten: null,
      comparedAs: null,
      note:
        `the result exceeds ${cap.toLocaleString('en-US')} rows — comparing all of them is what ` +
        'the check means, so it was not run. The re-plan proof stands on its own',
    };
  }

  const onlyA = n(row.only_in_a);
  const onlyB = n(row.only_in_b);
  if (onlyA === 0 && onlyB === 0) {
    return {
      status: 'match',
      rowsOriginal: aRows,
      rowsRewritten: bRows,
      onlyInOriginal: 0,
      onlyInRewritten: 0,
      comparedAs,
      note:
        `both forms returned identical rows (${aRows.toLocaleString('en-US')} compared` +
        `${comparedAs === 'text' ? ', as text — the row type has no equality operator' : ''}). ` +
        'That proves equivalence on this data, not for all inputs',
    };
  }
  return {
    status: 'mismatch',
    rowsOriginal: aRows,
    rowsRewritten: bRows,
    onlyInOriginal: onlyA,
    onlyInRewritten: onlyB,
    comparedAs,
    note:
      `the forms disagree: ${onlyA.toLocaleString('en-US')} row(s) only in the original, ` +
      `${onlyB.toLocaleString('en-US')} only in the rewrite. Do not apply this rewrite. ` +
      '(If the only differing columns are floating-point aggregates, this can be summation ' +
      'order rather than a semantic difference.)',
  };
}
