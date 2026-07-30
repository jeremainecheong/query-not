import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeRewrites, initParser, SqlParseError, type RewriteFinding, type RewriteKind } from '../src/rewrite.ts';

before(async () => {
  await initParser();
});

function kinds(sql: string): RewriteKind[] {
  return analyzeRewrites(sql).map((f) => f.kind);
}

function find(sql: string, kind: RewriteKind): RewriteFinding | undefined {
  return analyzeRewrites(sql).find((f) => f.kind === kind);
}

describe('function-on-column', () => {
  test('detects date() wrapping a column', () => {
    const f = find("SELECT * FROM orders WHERE date(created_at) = '2024-01-01'", 'function-on-column');
    assert.ok(f, 'expected the wrapped column to be detected');
    assert.equal(f.severity, 'critical');
    assert.match(f.title, /created_at/);
    assert.match(f.suggestion, /expression index|>=/);
  });

  test('detects lower() wrapping a column', () => {
    const f = find("SELECT * FROM users WHERE lower(email) = 'a@b.com'", 'function-on-column');
    assert.ok(f);
    assert.match(f.title, /lower\(\)/);
  });

  test('detects the function on the right-hand side too', () => {
    assert.ok(kinds("SELECT * FROM t WHERE '2024-01-01' = date(created_at)").includes('function-on-column'));
  });

  test('does not flag a function with no column argument', () => {
    // now() takes nothing from the table, so it does not defeat an index.
    assert.equal(kinds('SELECT * FROM orders WHERE created_at > now()').includes('function-on-column'), false);
  });

  test('does not flag a function applied to the compared value', () => {
    assert.equal(
      kinds("SELECT * FROM orders WHERE created_at > now() - interval '30 days'").includes('function-on-column'),
      false,
    );
  });

  test('does not flag a bare indexed comparison', () => {
    assert.equal(kinds("SELECT * FROM orders WHERE status = 'x'").includes('function-on-column'), false);
  });
});

describe('NOT IN', () => {
  test('flags a subquery form as critical, with the null trap explained', () => {
    const f = find('SELECT * FROM a WHERE id NOT IN (SELECT a_id FROM b)', 'not-in-subquery');
    assert.ok(f);
    assert.equal(f.severity, 'critical');
    assert.match(f.detail, /NULL/);
    assert.match(f.suggestion, /NOT EXISTS/);
  });

  test('reports the rewrite as a semantic change, not a free win', () => {
    // This is the field that makes the advisor safe to act on.
    const f = find('SELECT * FROM a WHERE id NOT IN (SELECT a_id FROM b)', 'not-in-subquery');
    assert.ok(f?.semanticChange, 'NOT IN → NOT EXISTS changes results and must say so');
    assert.match(f.semanticChange, /change your result set|NULL/i);
  });

  test('treats a literal list as a lesser, informational risk', () => {
    const f = find('SELECT * FROM a WHERE id NOT IN (1, 2, 3)', 'not-in-list');
    assert.ok(f);
    assert.equal(f.severity, 'info');
  });

  test('does not flag plain IN', () => {
    const found = kinds('SELECT * FROM a WHERE id IN (SELECT a_id FROM b)');
    assert.equal(found.includes('not-in-subquery'), false);
    assert.equal(found.includes('not-in-list'), false);
  });

  test('does not flag NOT EXISTS, which is the recommended form', () => {
    assert.equal(
      kinds('SELECT * FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id)').includes('not-in-subquery'),
      false,
    );
  });
});

describe('leading wildcard', () => {
  test('flags LIKE with a leading %', () => {
    const f = find("SELECT * FROM t WHERE name LIKE '%smith'", 'leading-wildcard');
    assert.ok(f);
    assert.match(f.suggestion, /pg_trgm|gin/i);
  });

  test('flags case-insensitive ILIKE too', () => {
    assert.ok(kinds("SELECT * FROM t WHERE name ILIKE '%smith%'").includes('leading-wildcard'));
  });

  test('does not flag a left-anchored pattern, which an index can serve', () => {
    assert.equal(kinds("SELECT * FROM t WHERE name LIKE 'smith%'").includes('leading-wildcard'), false);
  });
});

describe('large OFFSET', () => {
  test('flags a deep offset and explains the cost growth', () => {
    const f = find('SELECT * FROM t ORDER BY id OFFSET 50000 LIMIT 20', 'large-offset');
    assert.ok(f);
    assert.match(f.title, /50,000/);
    assert.match(f.suggestion, /keyset/i);
    assert.ok(f.semanticChange, 'keyset pagination cannot do numbered pages — that must be stated');
  });

  test('ignores a shallow offset', () => {
    assert.equal(kinds('SELECT * FROM t ORDER BY id OFFSET 20 LIMIT 20').includes('large-offset'), false);
  });

  test('ignores a query with no offset', () => {
    assert.equal(kinds('SELECT * FROM t ORDER BY id LIMIT 20').includes('large-offset'), false);
  });
});

describe('SELECT *', () => {
  test('flags it, at info severity', () => {
    const f = find('SELECT * FROM orders', 'select-star');
    assert.ok(f);
    assert.equal(f.severity, 'info');
    assert.match(f.detail, /index-only scan/);
  });

  test('does not flag an explicit column list', () => {
    assert.equal(kinds('SELECT id, status FROM orders').includes('select-star'), false);
  });

  test('does not flag count(*), which selects no columns', () => {
    assert.equal(kinds('SELECT count(*) FROM orders').includes('select-star'), false);
  });
});

describe('OR across columns', () => {
  test('flags an OR spanning two different columns', () => {
    const f = find("SELECT * FROM t WHERE a = 1 OR b = 2", 'or-across-columns');
    assert.ok(f);
    assert.match(f.suggestion, /UNION ALL/);
    assert.ok(f.semanticChange, 'UNION ALL can duplicate rows — that must be stated');
  });

  test('does not flag an OR on the same column, which is just an IN list', () => {
    assert.equal(kinds('SELECT * FROM t WHERE a = 1 OR a = 2').includes('or-across-columns'), false);
  });
});

describe('correlated subquery in the select list', () => {
  test('flags it as the hidden N+1 that it is', () => {
    const f = find(
      'SELECT u.id, (SELECT count(*) FROM orders o WHERE o.user_id = u.id) FROM users u',
      'correlated-subquery-in-select',
    );
    assert.ok(f);
    assert.match(f.detail, /N\+1|per(y| )row|every row/i);
    assert.match(f.suggestion, /LATERAL|LEFT JOIN/);
  });

  test('does not flag a subquery in the FROM clause', () => {
    assert.equal(
      kinds('SELECT x.n FROM (SELECT count(*) AS n FROM orders) x').includes('correlated-subquery-in-select'),
      false,
    );
  });
});

describe('parser behaviour', () => {
  test('reports a syntax error rather than silently returning nothing', () => {
    assert.throws(() => analyzeRewrites('SELECT FROM WHERE'), SqlParseError);
  });

  test('a clean, well-written query produces no critical findings', () => {
    const findings = analyzeRewrites(`
      SELECT o.id, o.total_cents
      FROM orders o
      WHERE o.status = 'pending'
        AND o.created_at >= '2024-01-01'
      ORDER BY o.created_at DESC
      LIMIT 20
    `);
    assert.equal(
      findings.filter((f) => f.severity === 'critical').length,
      0,
      `expected silence, got: ${findings.map((f) => f.kind).join(', ')}`,
    );
  });

  test('finds several independent problems in one query', () => {
    const found = kinds(`
      SELECT *
      FROM orders
      WHERE date(created_at) = '2024-01-01'
        AND id NOT IN (SELECT order_id FROM refunds)
      ORDER BY id
      OFFSET 100000 LIMIT 20
    `);
    for (const expected of ['select-star', 'function-on-column', 'not-in-subquery', 'large-offset'] as RewriteKind[]) {
      assert.ok(found.includes(expected), `missing ${expected}; got ${found.join(', ')}`);
    }
  });

  test('handles CTEs and joins without falling over', () => {
    const findings = analyzeRewrites(`
      WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days')
      SELECT c.email, count(*)
      FROM recent r JOIN customers c ON c.id = r.customer_id
      GROUP BY c.email
    `);
    assert.ok(findings.some((f) => f.kind === 'select-star'));
  });

  test('deduplicates the same pattern reported from several branches', () => {
    const findings = analyzeRewrites("SELECT * FROM t WHERE date(a) = '2024-01-01'");
    const wrapped = findings.filter((f) => f.kind === 'function-on-column');
    assert.equal(wrapped.length, 1);
  });
});
