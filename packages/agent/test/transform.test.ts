import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'libpg-query';

import { initParser } from '../src/rewrite.ts';
import {
  byteToCharIndex,
  charToByteIndex,
  literalEnd,
  matchParen,
  generateFunctionOnColumn,
  generateNotInList,
  generateNotInSubquery,
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

  test('invents an alias when the subquery table has none', () => {
    const c = ok(notInSubquery('SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM order_items)'));
    assert.match(c.sql, /FROM order_items AS qn_0 WHERE qn_0\.order_id = orders\.id/);
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

describe('snippetAt reports the right fragment on non-ASCII SQL', () => {
  test('the snippet is anchored to the token, not shifted by byte drift', async () => {
    const { analyzeRewrites } = await import('../src/rewrite.ts');
    const sql = "SELECT * FROM t WHERE note = 'café' AND date(created_at) = '2024-01-01'";
    const f = analyzeRewrites(sql).find((x) => x.kind === 'function-on-column');
    assert.ok(f, 'expected the wrapped column to be found');
    assert.ok(f.snippet?.includes('date(created_at)'), `snippet drifted: ${f.snippet}`);
  });
});
