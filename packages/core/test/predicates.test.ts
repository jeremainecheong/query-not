import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractColumns, orderForIndex, quoteIdent } from '../src/predicates.ts';

const names = (predicate: string) => extractColumns(predicate).map((c) => c.name).sort();

describe('extractColumns', () => {
  test('pulls a plain equality column', () => {
    assert.deepEqual(names('(customer_id = 42)'), ['customer_id']);
  });

  test('sees through a cast on the column', () => {
    const cols = extractColumns("((status)::text = 'pending'::text)");
    assert.equal(cols.length, 1);
    assert.equal(cols[0]?.name, 'status');
    assert.equal(cols[0]?.op, 'eq');
  });

  test('handles a multi-column conjunction', () => {
    assert.deepEqual(
      names("((status)::text = 'x'::text AND (created_at > '2024-01-01'::timestamptz))"),
      ['created_at', 'status'],
    );
  });

  test('never mistakes literal contents for column names', () => {
    // The literal contains something that looks exactly like `col = 1`.
    assert.deepEqual(names("(note = 'evil_col = 1')"), ['note']);
  });

  test('does not treat a cast target type as a column', () => {
    const cols = names("(created_at > '2024-01-01'::date)");
    assert.deepEqual(cols, ['created_at']);
    assert.equal(cols.includes('date'), false);
  });

  test('does not treat a logical keyword before a paren as a function wrapper', () => {
    const cols = extractColumns('((a = 1) AND (b = 2))');
    for (const c of cols) {
      assert.equal(c.wrappedIn, null, `${c.name} was wrongly attributed to a wrapper`);
    }
  });

  describe('function-wrapped columns', () => {
    // Regression: `date` is both a type name and a function name. Treating the
    // two as one list silently suppressed this warning, which would have
    // shipped an index suggestion that cannot work.
    test('detects date(col), which a b-tree on col cannot serve', () => {
      const cols = extractColumns("(date(created_at) = '2024-01-01'::date)");
      const col = cols.find((c) => c.name === 'created_at');
      assert.ok(col, `expected created_at, got ${cols.map((c) => c.name).join(',')}`);
      assert.equal(col.wrappedIn, 'date');
    });

    test('detects lower(col)', () => {
      const cols = extractColumns("(lower(email) = 'a@b.com'::text)");
      const col = cols.find((c) => c.name === 'email');
      assert.ok(col);
      assert.equal(col.wrappedIn, 'lower');
    });
  });

  describe('operator classification', () => {
    const cases: Array<[string, string, string]> = [
      ['(a = 1)', 'a', 'eq'],
      ['(a > 1)', 'a', 'range'],
      ['(a <= 1)', 'a', 'range'],
      ["(a ~~ 'x%'::text)", 'a', 'pattern'],
      ["(a = ANY ('{1,2}'::integer[]))", 'a', 'membership'],
      ['(a <> 1)', 'a', 'other'],
    ];
    for (const [predicate, name, op] of cases) {
      test(`${predicate} → ${op}`, () => {
        const col = extractColumns(predicate).find((c) => c.name === name);
        assert.ok(col, `no column extracted from ${predicate}`);
        assert.equal(col.op, op);
      });
    }
  });

  test('keeps the most selective usage when a column appears twice', () => {
    // A range and an equality on the same column: equality wins, because it is
    // what decides the column's position in a composite index.
    const cols = extractColumns("((created_at > '2024-01-01') AND (created_at = '2024-06-01'))");
    const col = cols.find((c) => c.name === 'created_at');
    assert.ok(col);
    assert.equal(col.op, 'eq');
  });

  test('returns nothing for a null or empty predicate', () => {
    assert.deepEqual(extractColumns(null), []);
    assert.deepEqual(extractColumns(''), []);
  });
});

describe('orderForIndex', () => {
  test('puts equality columns before range columns', () => {
    // The rule that matters: (created_at, status) can only use created_at as a
    // scan boundary. (status, created_at) uses both.
    const cols = extractColumns("((created_at > '2024-01-01'::date) AND (status = 'x'::text))");
    const ordered = orderForIndex(cols).map((c) => c.name);
    assert.deepEqual(ordered, ['status', 'created_at']);
  });

  test('keeps only one range column, since trailing ranges cannot bound a scan', () => {
    const cols = extractColumns('((a > 1) AND (b > 2) AND (c > 3))');
    assert.equal(orderForIndex(cols).length, 1);
  });

  test('drops columns whose operator no index can serve', () => {
    const cols = extractColumns('((a <> 1) AND (b = 2))');
    assert.deepEqual(orderForIndex(cols).map((c) => c.name), ['b']);
  });
});

describe('quoteIdent', () => {
  test('leaves plain lower-case identifiers alone', () => {
    assert.equal(quoteIdent('created_at'), 'created_at');
  });

  test('quotes anything needing it, escaping embedded quotes', () => {
    assert.equal(quoteIdent('Mixed Case'), '"Mixed Case"');
    assert.equal(quoteIdent('we"ird'), '"we""ird"');
  });
});
