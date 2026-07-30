import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'libpg-query';

import { initParser } from '../src/rewrite.ts';
import {
  byteToCharIndex,
  charToByteIndex,
  literalEnd,
  matchParen,
  generateCorrelatedSelect,
  generateFunctionOnColumn,
  generateNotInList,
  generateNotInSubquery,
  generateOrSplit,
  validateReconstruction,
  validateSplice,
  type CandidateResult,
} from '../src/transform.ts';

before(async () => {
  await initParser();
});

type Node = Record<string, any>;

const stmtOf = (sql: string): Node => parseSync(sql).stmts[0].stmt.SelectStmt;

/** Find the first node of `type` anywhere in a subtree, as the walker does. */
function findNode(value: unknown, type: string, match?: (n: Node) => boolean): Node | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = findNode(v, type, match);
      if (r) return r;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value as Node)) {
    if (k === type && v && typeof v === 'object' && (!match || match(v as Node))) return v as Node;
    const r = findNode(v, type, match);
    if (r) return r;
  }
  return null;
}

const notInSubquery = (sql: string): CandidateResult => {
  const stmt = stmtOf(sql);
  const link = findNode(stmt, 'SubLink', (n) => n['subLinkType'] === 'ANY_SUBLINK');
  assert.ok(link, 'test fixture has no ANY_SUBLINK');
  return generateNotInSubquery(sql, stmt, link);
};

const notInList = (sql: string): CandidateResult => {
  const stmt = stmtOf(sql);
  const expr = findNode(stmt, 'A_Expr', (n) => n['kind'] === 'AEXPR_IN');
  assert.ok(expr, 'test fixture has no AEXPR_IN');
  return generateNotInList(sql, stmt, expr);
};

const dateCall = (sql: string): CandidateResult => {
  const stmt = stmtOf(sql);
  const expr = findNode(stmt, 'A_Expr', (n) => !!findNode(n, 'FuncCall'));
  assert.ok(expr, 'test fixture has no FuncCall comparison');
  return generateFunctionOnColumn(sql, stmt, expr);
};

const orSplit = (sql: string): CandidateResult => {
  const stmt = stmtOf(sql);
  const or = findNode(stmt, 'BoolExpr', (n) => n['boolop'] === 'OR_EXPR');
  assert.ok(or, 'test fixture has no OR');
  return generateOrSplit(sql, stmt, or);
};

const correlated = (sql: string): CandidateResult => {
  const stmt = stmtOf(sql);
  const link = findNode(stmt, 'SubLink', (n) => n['subLinkType'] === 'EXPR_SUBLINK');
  assert.ok(link, 'test fixture has no EXPR_SUBLINK');
  return generateCorrelatedSelect(sql, stmt, link);
};

const ok = (r: CandidateResult) => {
  assert.ok(r.ok, `expected a candidate, got: ${r.ok ? '' : r.blocked}`);
  return r.candidate;
};
const blocked = (r: CandidateResult): string => {
  assert.equal(r.ok, false, 'expected the transform to refuse');
  return (r as { ok: false; blocked: string }).blocked;
};

describe('byte and character offsets', () => {
  // libpg_query reports byte offsets. Indexing a JS string with one produces a
  // valid-but-different query, which is the worst failure this module can have.
  const sql = "SELECT * FROM t WHERE note = 'café' AND date(created_at) = '2024-01-01'";

  test('the two domains genuinely differ on multibyte input', () => {
    assert.notEqual(Buffer.byteLength(sql, 'utf8'), sql.length);
    assert.equal(Buffer.from(sql, 'utf8').indexOf('date('), 41);
    assert.equal(sql.indexOf('date('), 40);
  });

  test('round-trips', () => {
    assert.equal(byteToCharIndex(sql, 41), 40);
    assert.equal(charToByteIndex(sql, 40), 41);
    assert.equal(byteToCharIndex(sql, 0), 0);
    assert.equal(byteToCharIndex(sql, 10_000), sql.length);
  });

  test('splices around a multibyte literal without disturbing it', () => {
    const c = ok(dateCall(sql));
    assert.ok(c.sql.includes("'café'"), 'the é was corrupted by the splice');
    assert.ok(c.sql.includes("created_at >= '2024-01-01'::date"));
    assert.notEqual(c.byteSpan.start, c.charSpan.start);
  });
});

describe('scanners', () => {
  test('matchParen skips parens inside string literals', () => {
    const buf = Buffer.from("f(a, ')', b)");
    assert.equal(matchParen(buf, 1), 11);
  });

  test('matchParen handles doubled-quote escapes', () => {
    const buf = Buffer.from("f('it''s )', b)");
    assert.equal(matchParen(buf, 1), 14);
  });

  test('matchParen skips line and block comments', () => {
    const buf = Buffer.from('f(a /* ) */ , b -- )\n)');
    assert.equal(matchParen(buf, 1), 21);
  });

  test('matchParen returns -1 when unbalanced', () => {
    assert.equal(matchParen(Buffer.from('f(a, b'), 1), -1);
  });

  test('literalEnd covers quoted and numeric tokens', () => {
    assert.equal(literalEnd(Buffer.from("'abc' rest"), 0), 5);
    assert.equal(literalEnd(Buffer.from("'it''s' rest"), 0), 7);
    assert.equal(literalEnd(Buffer.from('12345)'), 0), 5);
  });
});

describe('not-in-subquery', () => {
  test('rewrites to NOT EXISTS and keeps the inner WHERE verbatim', () => {
    const c = ok(notInSubquery(
      'SELECT * FROM orders o WHERE o.id NOT IN (SELECT oi.order_id FROM order_items oi WHERE oi.qty > 1)'));
    assert.match(c.sql, /NOT EXISTS \(SELECT 1 FROM order_items AS oi WHERE \(oi\.qty > 1\) AND oi\.order_id = o\.id\)/);
  });

  test('a bare subquery table keeps its own name as the qualifier', () => {
    // Inventing an alias here would hide the table's name from an inner WHERE
    // preserved verbatim — `order_items.qty` under `FROM order_items AS qn_0`
    // stops meaning the inner table. The name itself is the safe qualifier.
    const c = ok(notInSubquery('SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM order_items)'));
    assert.match(c.sql, /FROM order_items WHERE order_items\.order_id = orders\.id/);
  });

  test('table-name references in the preserved inner WHERE stay valid', () => {
    const c = ok(notInSubquery(
      'SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM order_items WHERE order_items.qty > 1)'));
    assert.match(c.sql, /FROM order_items WHERE \(order_items\.qty > 1\) AND order_items\.order_id = orders\.id/);
  });

  test('self NOT IN gets a fresh alias only when nothing names the table', () => {
    const c = ok(notInSubquery('SELECT * FROM orders WHERE id NOT IN (SELECT customer_id FROM orders)'));
    assert.match(c.sql, /FROM orders AS qn_0 WHERE qn_0\.customer_id = orders\.id/);
  });

  test('refuses self NOT IN when the inner WHERE names the table', () => {
    const why = blocked(notInSubquery(
      'SELECT * FROM orders WHERE id NOT IN (SELECT customer_id FROM orders WHERE orders.total_cents > 0)'));
    assert.match(why, /by name/);
  });

  test('declares NOT NULL preconditions for both columns', () => {
    const c = ok(notInSubquery('SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM order_items)'));
    assert.equal(c.preconditions.length, 2);
    const roles = c.preconditions.map((p) => p.role).sort();
    assert.deepEqual(roles, ['outer', 'subquery']);
    assert.ok(c.preconditions.every((p) => p.kind === 'column-not-null'));
  });

  // An outer join makes attnotnull a lie about the value at runtime: the column
  // is NOT NULL in storage and still NULL in the result. The catalog cannot see
  // that, so the AST has to refuse before the catalog is ever consulted.
  test('refuses when the statement contains an outer join', () => {
    const why = blocked(notInSubquery(
      'SELECT * FROM a LEFT JOIN b ON b.a_id = a.id WHERE b.x NOT IN (SELECT y FROM c)'));
    assert.match(why, /outer join/);
  });

  test('refuses an unqualified column when several tables are in scope', () => {
    assert.match(blocked(notInSubquery('SELECT * FROM a, b WHERE x NOT IN (SELECT y FROM c)')), /unqualified/);
  });

  // The subquery alias would capture the outer reference and silently change
  // which table `t.id` means.
  test('refuses when the subquery alias shadows the outer table', () => {
    assert.match(blocked(notInSubquery('SELECT * FROM t WHERE t.id NOT IN (SELECT t.ref FROM other t)')), /shadows/);
  });

  test('refuses subqueries that are not a plain single-column read', () => {
    for (const sql of [
      'SELECT * FROM o WHERE o.id NOT IN (SELECT a.x FROM a JOIN b ON b.id = a.id)',
      'SELECT * FROM o WHERE o.id NOT IN (SELECT DISTINCT x FROM a)',
      'SELECT * FROM o WHERE o.id NOT IN (SELECT x FROM a GROUP BY x)',
      'SELECT * FROM o WHERE o.id NOT IN (SELECT x FROM a LIMIT 10)',
    ]) {
      assert.equal(notInSubquery(sql).ok, false, `should have refused: ${sql}`);
    }
  });

  test('refuses an expression on the left', () => {
    assert.match(blocked(notInSubquery(
      'SELECT * FROM o WHERE lower(o.code) NOT IN (SELECT x FROM a)')), /not a plain column/);
  });
});

describe('not-in-list', () => {
  test('rewrites to a VALUES anti-join', () => {
    const c = ok(notInList("SELECT * FROM orders WHERE status NOT IN ('a', 'b')"));
    assert.match(c.sql, /NOT EXISTS \(SELECT 1 FROM \(VALUES \('a'\), \('b'\)\) AS qn_0\(v\) WHERE qn_0\.v = orders\.status\)/);
  });

  // <> ALL (ARRAY[…]) is what Postgres already builds for a list, so emitting it
  // would be a no-op wearing a rewrite's clothes.
  test('does not emit the ARRAY form', () => {
    assert.doesNotMatch(ok(notInList("SELECT * FROM o WHERE s NOT IN ('a')")).sql, /ALL \(ARRAY/);
  });

  test('refuses a list containing NULL', () => {
    assert.match(blocked(notInList("SELECT * FROM orders WHERE status NOT IN ('a', NULL)")), /NULL/);
  });

  test('refuses a list of expressions', () => {
    assert.equal(notInList('SELECT * FROM o WHERE s NOT IN (1 + 1, 2)').ok, false);
  });
});

describe('function-on-column', () => {
  test('equality becomes a half-open range', () => {
    const c = ok(dateCall("SELECT * FROM orders WHERE date(created_at) = '2026-07-01'"));
    assert.match(c.sql, /orders\.created_at >= '2026-07-01'::date AND orders\.created_at < '2026-07-01'::date \+ 1/);
  });

  test('each inequality gets the correct boundary', () => {
    const cases: Array<[string, RegExp]> = [
      ['<', /< '2026-07-01'::date\)/],
      ['<=', /< '2026-07-01'::date \+ 1\)/],
      ['>', />= '2026-07-01'::date \+ 1\)/],
      ['>=', />= '2026-07-01'::date\)/],
    ];
    for (const [op, expected] of cases) {
      const c = ok(dateCall(`SELECT * FROM orders WHERE date(created_at) ${op} '2026-07-01'`));
      assert.match(c.sql, expected, `wrong boundary for ${op}`);
    }
  });

  test('declares a column-type precondition and no NOT NULL one', () => {
    // date(NULL) op D and the range form both yield NULL and filter alike, so
    // nullability is irrelevant here — claiming otherwise would be noise.
    const c = ok(dateCall("SELECT * FROM orders WHERE date(created_at) = '2026-07-01'"));
    assert.equal(c.preconditions.length, 1);
    assert.equal(c.preconditions[0].kind, 'column-type-supported');
  });

  test('refuses functions with no range equivalent', () => {
    assert.match(blocked(dateCall("SELECT * FROM orders WHERE lower(note) = 'x'")), /no range equivalent/);
  });

  test('refuses date() over an expression', () => {
    assert.equal(dateCall("SELECT * FROM o WHERE date(a + b) = '2026-07-01'").ok, false);
  });
});

describe('validation by reparse', () => {
  test('accepts a splice that changes exactly the intended region', () => {
    assert.equal(
      validateSplice(
        "SELECT * FROM t WHERE date(c) = '2026-07-01'",
        "SELECT * FROM t WHERE (t.c >= '2026-07-01'::date AND t.c < '2026-07-01'::date + 1)",
        "(t.c >= '2026-07-01'::date AND t.c < '2026-07-01'::date + 1)"),
      null);
  });

  test('an AND replacement inside an OR needs no parentheses to stay correct', () => {
    // AND already binds tighter than OR, so `x = 1 OR A AND B` parses as
    // `x = 1 OR (A AND B)`. The generator parenthesises anyway, but the
    // validator should not invent a problem that is not there.
    assert.equal(
      validateSplice(
        "SELECT * FROM t WHERE x = 1 OR date(c) = '2026-07-01'",
        "SELECT * FROM t WHERE x = 1 OR t.c >= '2026-07-01'::date AND t.c < '2026-07-01'::date + 1",
        "(t.c >= '2026-07-01'::date AND t.c < '2026-07-01'::date + 1)"),
      null);
  });

  test('rejects a splice whose dropped parentheses really did change precedence', () => {
    // An OR replacement spliced into an AND context without parentheses: the
    // tree becomes (x = 1 AND a = 3) OR b = 4, which is not what was written.
    const problem = validateSplice(
      'SELECT * FROM t WHERE x = 1 AND y = 2',
      'SELECT * FROM t WHERE x = 1 AND a = 3 OR b = 4',
      '(a = 3 OR b = 4)');
    assert.ok(problem, 'the precedence break should have been rejected');
  });

  test('rejects a rewrite that disturbs a second part of the query', () => {
    const problem = validateSplice(
      "SELECT a FROM t WHERE date(c) = '2026-07-01'",
      "SELECT b FROM t WHERE (t.c >= '2026-07-01'::date AND t.c < '2026-07-01'::date + 1)",
      "(t.c >= '2026-07-01'::date AND t.c < '2026-07-01'::date + 1)");
    assert.ok(problem, 'a change to the select list should have been rejected');
  });

  test('rejects unparsable output', () => {
    assert.ok(validateSplice('SELECT 1 WHERE a = 1', 'SELECT 1 WHERE ((', '(('));
  });
});

describe('generated candidates survive the advisor', () => {
  // Whatever we emit must not still trip the finding it came from, or the tool
  // would be recommending a rewrite of its own rewrite.
  test('the rewritten SQL parses and no longer contains NOT IN', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const c = ok(notInSubquery('SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM order_items)'));
    const kinds = analyzeRewrites(c.sql).map((f) => f.kind);
    assert.ok(!kinds.includes('not-in-subquery'), `still flagged: ${kinds.join(', ')}`);
  });

  test('the date() rewrite no longer trips function-on-column', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const c = ok(dateCall("SELECT id FROM orders WHERE date(created_at) = '2026-07-01'"));
    const kinds = analyzeRewrites(c.sql).map((f) => f.kind);
    assert.ok(!kinds.includes('function-on-column'), `still flagged: ${kinds.join(', ')}`);
  });
});

describe('or-across-columns', () => {
  test('splits a two-arm OR into guarded UNION ALL arms', () => {
    const c = ok(orSplit("SELECT id, total FROM orders WHERE customer_id = 42 OR status = 'pending'"));
    assert.ok(c.sql.includes('UNION ALL'));
    assert.ok(c.sql.includes("status = 'pending' AND (customer_id = 42) IS NOT TRUE"));
    assert.equal(c.preconditions.length, 0);
  });

  test('three arms get cumulative guards — one, then two', () => {
    const c = ok(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2 OR c = 3'));
    assert.equal(c.sql.split('UNION ALL').length, 3);
    assert.equal(c.sql.match(/IS NOT TRUE/g)?.length, 3);
    assert.ok(c.sql.includes('c = 3 AND (a = 1) IS NOT TRUE AND (b = 2) IS NOT TRUE'));
  });

  test('parenthesised arms and a fully wrapped WHERE both slice cleanly', () => {
    ok(orSplit('SELECT id FROM t WHERE (a = 1) OR (b = 2)'));
    ok(orSplit('SELECT id FROM t WHERE (a = 1 OR b = 2)'));
    ok(orSplit('SELECT id FROM t WHERE ((a = 1) OR (b = 2))'));
  });

  test('an arm that is itself an AND keeps a flat AND chain when guarded', () => {
    // Reparsing flattens AND, so the expected tree must splice guards into the
    // arm's own args — a nested BoolExpr here would fail validation.
    const c = ok(orSplit('SELECT id FROM t WHERE (a = 1 AND c = 2) OR b = 3'));
    assert.ok(c.sql.includes('b = 3 AND (a = 1 AND c = 2) IS NOT TRUE'));
  });

  test('ORDER BY and LIMIT hoist to the set operation, out of the arms', () => {
    const c = ok(orSplit('SELECT id, created_at FROM t WHERE a = 1 OR b = 2 ORDER BY created_at DESC LIMIT 10'));
    const arms = c.sql.split('UNION ALL');
    assert.ok(!arms[0].includes('ORDER BY'));
    assert.ok(/ORDER BY created_at DESC\s+LIMIT 10$/.test(c.sql.trim()));
  });

  test('a sort key that is not an output column name refuses', () => {
    assert.match(blocked(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2 ORDER BY t.id')), /output column/);
    assert.match(blocked(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2 ORDER BY lower(id)')), /output column/);
  });

  test('ordinal sort keys are fine', () => {
    ok(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2 ORDER BY 1'));
  });

  test('SELECT * splits, but not under ORDER BY', () => {
    ok(orSplit('SELECT * FROM t WHERE a = 1 OR b = 2'));
    assert.match(blocked(orSplit('SELECT * FROM t WHERE a = 1 OR b = 2 ORDER BY id')), /SELECT \*/);
  });

  test('refuses shapes the split would change: grouping, DISTINCT, windows, CTEs, locking', () => {
    assert.match(blocked(orSplit('SELECT max(id) FROM t WHERE a = 1 OR b = 2 GROUP BY c')), /GROUP BY/);
    assert.match(blocked(orSplit('SELECT DISTINCT id FROM t WHERE a = 1 OR b = 2')), /DISTINCT/);
    assert.match(blocked(orSplit('SELECT sum(x) OVER () FROM t WHERE a = 1 OR b = 2')), /window/);
    assert.match(blocked(orSplit('WITH w AS (SELECT 1) SELECT id FROM t WHERE a = 1 OR b = 2')), /WITH/);
    assert.match(blocked(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2 FOR UPDATE')), /locking/);
  });

  test('refuses an OR that is not the whole WHERE clause', () => {
    assert.match(blocked(orSplit('SELECT id FROM t WHERE c = 1 AND (a = 1 OR b = 2)')), /whole\s+WHERE/);
  });

  test('a syntactic aggregate refuses; a plain call becomes a precondition', () => {
    assert.match(blocked(orSplit('SELECT count(*) FROM t WHERE a = 1 OR b = 2')), /aggregate/);
    const c = ok(orSplit('SELECT sum(total) FROM orders WHERE a = 1 OR b = 2'));
    assert.equal(c.preconditions.length, 1);
    const p = c.preconditions[0];
    assert.equal(p.kind, 'function-not-aggregate');
    assert.deepEqual(p.kind === 'function-not-aggregate' ? p.functions : [], ['sum']);
  });

  test('multibyte text ahead of the arms does not shift the slices', () => {
    const c = ok(orSplit("SELECT id FROM t WHERE note = 'café' OR flag = true"));
    // Once in its own arm, once inside the guard on the second arm.
    assert.equal(c.sql.match(/café/g)?.length, 2);
  });

  test('a trailing semicolon does not leak into the arms', () => {
    const c = ok(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2;'));
    assert.ok(!c.sql.includes(';'));
  });

  test('refuses multi-statement input rather than dropping a sibling', () => {
    assert.match(blocked(orSplit('SELECT id FROM t WHERE a = 1 OR b = 2; SELECT 2')), /more than one statement/);
  });
});

describe('correlated-subquery-in-select', () => {
  const base = 'SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id) FROM orders o';

  test('hoists the value and joins the table, before the outer WHERE', () => {
    const c = ok(correlated(`${base} WHERE o.total > 5`));
    assert.ok(c.sql.includes('SELECT o.id, u.name FROM orders o'));
    assert.ok(c.sql.includes('LEFT JOIN users u ON u.id = o.user_id'));
    assert.ok(c.sql.indexOf('LEFT JOIN') < c.sql.indexOf('WHERE o.total'));
  });

  test('declares the unique-key precondition over the pinned columns', () => {
    const c = ok(correlated(base));
    assert.equal(c.preconditions.length, 1);
    const p = c.preconditions[0];
    assert.equal(p.kind, 'unique-key-covers');
    if (p.kind === 'unique-key-covers') {
      assert.deepEqual(p.relation, ['users']);
      assert.deepEqual(p.columns, ['id']);
    }
  });

  test('with no outer WHERE the join lands at the end', () => {
    const c = ok(correlated(base));
    assert.ok(c.sql.trimEnd().endsWith('ON u.id = o.user_id'));
  });

  test('an AS alias on the entry survives, attached to the hoisted value', () => {
    const c = ok(correlated(`${base.replace(') FROM', ') AS username FROM')}`));
    assert.ok(c.sql.includes('u.name AS username'));
  });

  test('only equality conjuncts pin; the rest travel into ON verbatim', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id AND u.created_at > o.created_at AND u.active = true) FROM orders o',
    ));
    const p = c.preconditions[0];
    assert.ok(p.kind === 'unique-key-covers' && p.columns.join(',') === 'active,id');
    assert.ok(c.sql.includes('ON u.id = o.user_id AND u.created_at > o.created_at AND u.active = true'));
  });

  test('joins after an existing outer join tree', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id) FROM orders o JOIN customers c ON c.id = o.customer_id',
    ));
    assert.ok(c.sql.indexOf('JOIN customers') < c.sql.indexOf('LEFT JOIN users'));
  });

  test('a parenthesised or compound value hoists cleanly', () => {
    ok(correlated('SELECT o.id, (SELECT (u.a + u.b) FROM users u WHERE u.id = o.user_id) FROM orders o'));
    const c = ok(correlated(
      "SELECT o.id, (SELECT u.first || ' ' || u.last FROM users u WHERE u.id = o.user_id) FROM orders o",
    ));
    assert.ok(c.sql.includes("u.first || ' ' || u.last FROM orders o"));
  });

  test('multibyte literals inside the subquery do not shift the slices', () => {
    const c = ok(correlated(
      "SELECT o.id, (SELECT u.name FROM users u WHERE u.note = 'café' AND u.id = o.user_id) FROM orders o",
    ));
    assert.ok(c.sql.includes("ON u.note = 'café' AND u.id = o.user_id"));
  });

  test('refuses when the inner name would collide with an outer name', () => {
    assert.match(
      blocked(correlated('SELECT u.id, (SELECT u2.name FROM users u2 WHERE u2.id = u.ref) FROM accounts u2')),
      /collide/,
    );
  });

  test('refuses unqualified or unscopable references inside the subquery', () => {
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT name FROM users u WHERE u.id = o.user_id) FROM orders o')),
      /unqualified/,
    );
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.name FROM users u WHERE u.id = x.user_id) FROM orders o')),
      /neither/,
    );
  });

  test('refuses an uncorrelated subquery — it already runs once', () => {
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.name FROM users u WHERE u.id = 1) FROM orders o')),
      /not correlated/,
    );
  });

  test('refuses when nothing is pinned by equality', () => {
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.name FROM users u WHERE u.created_at > o.created_at) FROM orders o')),
      /unique index/,
    );
  });

  test('refuses a comma-separated outer FROM', () => {
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id) FROM orders o, customers c')),
      /comma/,
    );
  });

  test('refuses subquery shapes a plain join cannot express', () => {
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id LIMIT 1) FROM orders o')),
      /LIMIT/,
    );
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id ORDER BY u.name) FROM orders o')),
      /lateral/,
    );
    assert.match(
      blocked(correlated('SELECT o.id, (SELECT u.a, u.b FROM users u WHERE u.id = o.user_id) FROM orders o')),
      /more than one column/,
    );
  });

  test('aggregate subqueries route to the grouped-join generator now', () => {
    // These used to refuse (count) or lean on function-not-aggregate (sum);
    // the grouped-join path owns both shapes since it exists.
    const c1 = ok(correlated('SELECT o.id, (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) FROM orders o'));
    assert.ok(c1.sql.includes('COALESCE'));
    const c2 = ok(correlated('SELECT o.id, (SELECT sum(i.qty) FROM order_items i WHERE i.order_id = o.id) FROM orders o'));
    assert.deepEqual(c2.preconditions.map(p => p.kind), ['function-is-aggregate']);
  });

  test('refuses a subquery that is not itself the select-list entry', () => {
    assert.match(
      blocked(correlated('SELECT o.id, 1 + (SELECT u.n FROM users u WHERE u.id = o.id) FROM orders o')),
      /nested inside an expression/,
    );
    assert.match(
      blocked(correlated('SELECT o.id FROM orders o WHERE o.total > (SELECT u.n FROM users u WHERE u.id = o.id)')),
      /select-list entry/,
    );
  });
});

describe('lateral top-1 (ORDER BY + LIMIT 1 subquery)', () => {
  const base =
    'SELECT o.id, (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.qty DESC LIMIT 1) FROM orders o';

  test('hoists the subquery verbatim into a LEFT JOIN LATERAL', () => {
    const c = ok(correlated(`${base} WHERE o.total_cents > 5`));
    assert.ok(c.sql.includes('LEFT JOIN LATERAL (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.qty DESC LIMIT 1) qn_0 ON true'));
    assert.ok(c.sql.includes('o.id, qn_0.sku'));
    assert.ok(c.sql.indexOf('LATERAL') < c.sql.indexOf('WHERE o.total_cents'));
  });

  test('the tie-break precondition covers correlation and sort columns', () => {
    const c = ok(correlated(base));
    const p = c.preconditions[0];
    assert.equal(p.kind, 'unique-key-covers');
    if (p.kind === 'unique-key-covers') {
      assert.deepEqual(p.relation, ['order_items']);
      assert.deepEqual(p.columns, ['order_id', 'qty']);
      assert.match(p.why, /tie/i);
    }
    // NULLs stay tied under a unique index, so every sort column also needs
    // NOT NULL established.
    const nn = c.preconditions.filter(x => x.kind === 'column-not-null');
    assert.deepEqual(nn.map(x => x.kind === 'column-not-null' ? x.column : ''), ['qty']);
  });

  test('an outer-qualified sort key contributes nothing to the pin set', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY o.id, i.qty LIMIT 1) FROM orders o',
    ));
    const p = c.preconditions[0];
    assert.ok(p.kind === 'unique-key-covers' && p.columns.join(',') === 'order_id,qty');
  });

  test('an AS alias names the hoisted reference', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT i.qty * 2 AS double_qty FROM order_items i WHERE i.order_id = o.id ORDER BY i.qty LIMIT 1) FROM orders o',
    ));
    assert.ok(c.sql.includes('qn_0.double_qty'));
  });

  test('an anonymous expression refuses with the AS advice', () => {
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT i.qty * 2 FROM order_items i WHERE i.order_id = o.id ORDER BY i.qty LIMIT 1) FROM orders o',
      )),
      /AS/,
    );
  });

  test('unqualified inner columns are fine — the body keeps its own scope', () => {
    // The plain-join path must refuse this; the lateral path must not.
    ok(correlated(
      'SELECT o.id, (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY qty LIMIT 1) FROM orders o',
    ));
  });

  test('LIMIT other than 1, or OFFSET, falls back to the plain-join refusals', () => {
    // Neither is the top-1 idiom, so both land on the plain path's ORDER BY
    // refusal, which names the lateral pattern this generator now covers.
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.qty LIMIT 2) FROM orders o',
      )),
      /lateral-join pattern/,
    );
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT i.sku FROM order_items i WHERE i.order_id = o.id ORDER BY i.qty LIMIT 1 OFFSET 1) FROM orders o',
      )),
      /lateral-join pattern/,
    );
  });

  test('a multi-table inner refuses: no single index pins the choice', () => {
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT i.sku FROM order_items i JOIN orders o2 ON o2.id = i.order_id WHERE i.order_id = o.id ORDER BY i.qty LIMIT 1) FROM orders o',
      )),
      /unique index/,
    );
  });
});

describe('grouped join (aggregate subquery)', () => {
  const base = 'SELECT o.id, (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) FROM orders o';

  test('count(*) becomes a grouped derived table with COALESCE 0', () => {
    const c = ok(correlated(base));
    assert.ok(c.sql.includes('LEFT JOIN (SELECT i.order_id, count(*) AS agg FROM order_items i GROUP BY i.order_id) qn_0 ON qn_0.order_id = o.id'));
    assert.ok(c.sql.includes('COALESCE(qn_0.agg, 0)'));
  });

  test('sum keeps NULL semantics — no COALESCE', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT sum(i.qty) FROM order_items i WHERE i.order_id = o.id) FROM orders o',
    ));
    assert.ok(!c.sql.includes('COALESCE'));
    assert.ok(c.sql.includes('sum(i.qty) AS agg'));
  });

  test('declares function-is-aggregate — the mirror precondition', () => {
    const c = ok(correlated(base));
    assert.deepEqual(c.preconditions.map(p => p.kind), ['function-is-aggregate']);
    const p = c.preconditions[0];
    assert.ok(p.kind === 'function-is-aggregate' && p.functions.join() === 'count');
  });

  test('residual inner-only conditions stay in the derived WHERE', () => {
    const c = ok(correlated(
      "SELECT o.id, (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.qty > 2 AND i.sku <> 'X') FROM orders o",
    ));
    assert.ok(c.sql.includes("WHERE i.qty > 2 AND i.sku <> 'X' GROUP BY i.order_id"));
  });

  test('an outer-referencing non-equality refuses — it cannot be decorrelated', () => {
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.qty > o.total_cents) FROM orders o',
      )),
      /cannot move/,
    );
  });

  test('count(DISTINCT col) is preserved verbatim', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT count(DISTINCT i.sku) FROM order_items i WHERE i.order_id = o.id) FROM orders o',
    ));
    assert.ok(c.sql.includes('count(DISTINCT i.sku) AS agg'));
    assert.ok(c.sql.includes('COALESCE'));
  });

  test('FILTER refuses; unknown aggregates refuse with the whitelist reason', () => {
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT count(*) FILTER (WHERE i.qty > 1) FROM order_items i WHERE i.order_id = o.id) FROM orders o',
      )),
      /FILTER/,
    );
  });

  test('an aggregate argument referencing the outer query refuses', () => {
    // count(o.id) passes the scope check — o is a real outer name — but the
    // argument cannot survive the move into an uncorrelated derived table.
    assert.match(
      blocked(correlated(
        'SELECT o.id, (SELECT count(o.id) FROM order_items i WHERE i.order_id = o.id) FROM orders o',
      )),
      /outer query/,
    );
  });

  test('a pinned column named agg forces a fresh aggregate alias', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT count(*) FROM order_items agg_t WHERE agg_t.agg = o.id) FROM orders o',
    ));
    assert.ok(!/AS agg\b.*\bagg\b.*AS agg\b/.test(c.sql));
    assert.match(c.sql, /AS agg_\d/);
  });

  test('multi-column correlation groups by all pins', () => {
    const c = ok(correlated(
      'SELECT o.id, (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.qty = o.total_cents) FROM orders o',
    ));
    assert.ok(c.sql.includes('GROUP BY i.order_id, i.qty') || c.sql.includes('GROUP BY i.qty, i.order_id'));
    assert.ok(c.sql.includes('ON qn_0.order_id = o.id AND qn_0.qty = o.total_cents') ||
              c.sql.includes('ON qn_0.qty = o.total_cents AND qn_0.order_id = o.id'));
  });
});

describe('validateReconstruction', () => {
  test('accepts equal structure regardless of formatting, refuses different structure', () => {
    const want = parseSync('SELECT id FROM t WHERE a = 1').stmts[0].stmt;
    assert.equal(validateReconstruction('SELECT id  FROM t /* c */ WHERE a = 1', want), null);
    assert.match(validateReconstruction('SELECT id FROM t WHERE a = 2', want)!, /intended structure/);
    assert.match(validateReconstruction('SELECT id FROM', want)!, /does not parse/);
  });
});

describe('Tier B candidates survive the advisor', () => {
  test('the OR split no longer trips or-across-columns and gets a candidate attached', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const sql = "SELECT id FROM orders WHERE customer_id = 1 OR status = 'x'";
    const finding = analyzeRewrites(sql).find(f => f.kind === 'or-across-columns');
    assert.ok(finding?.candidate, `no candidate: ${finding?.candidateBlocked}`);
    const again = analyzeRewrites(finding.candidate.sql).map(f => f.kind);
    assert.ok(!again.includes('or-across-columns'), `still flagged: ${again.join(', ')}`);
  });

  test('the join rewrite no longer trips correlated-subquery-in-select', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const sql = 'SELECT o.id, (SELECT u.name FROM users u WHERE u.id = o.user_id) FROM orders o';
    const finding = analyzeRewrites(sql).find(f => f.kind === 'correlated-subquery-in-select');
    assert.ok(finding?.candidate, `no candidate: ${finding?.candidateBlocked}`);
    const again = analyzeRewrites(finding.candidate.sql).map(f => f.kind);
    assert.ok(!again.includes('correlated-subquery-in-select'), `still flagged: ${again.join(', ')}`);
  });

  test('a nested-scope OR is blocked with a reason, not mis-generated', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const sql = 'SELECT id FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE qty = 1 OR price = 2)';
    const finding = analyzeRewrites(sql).find(f => f.kind === 'or-across-columns');
    assert.ok(finding, 'expected the nested OR finding');
    assert.equal(finding.candidate, null);
    assert.match(finding.candidateBlocked ?? '', /nested subquery/);
  });
});

describe('snippetAt reports the right fragment on non-ASCII SQL', () => {
  test('the snippet is anchored to the token, not shifted by byte drift', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const sql = "SELECT * FROM t WHERE note = 'café' AND date(created_at) = '2024-01-01'";
    const f = analyzeRewrites(sql).find((x) => x.kind === 'function-on-column');
    assert.ok(f, 'expected the wrapped column to be found');
    assert.ok(f.snippet?.includes('date(created_at)'), `snippet drifted: ${f.snippet}`);
  });
});
