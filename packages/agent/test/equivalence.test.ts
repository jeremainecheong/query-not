import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseSync } from 'libpg-query';

import { initParser } from '../src/rewrite.ts';
import {
  buildComparisonSql,
  equivalenceGuard,
  freshPrefix,
  harvestFunctionNames,
  interpretComparison,
} from '../src/equivalence.ts';

before(async () => {
  await initParser();
});

const NO_VOLATILE = new Set<string>();

describe('the guard', () => {
  test('a plain query is checkable', () => {
    const g = equivalenceGuard(parseSync('SELECT * FROM t WHERE a = 1'), NO_VOLATILE);
    assert.equal(g.checkable, true);
  });

  // Which rows survive a LIMIT depends on tie-breaking; the rewrite changes the
  // plan and the plan is the tie-breaker. A naive implementation reports
  // "proven" here — this refusal is the difference between the two.
  test('LIMIT refuses with the tie-breaking reason', () => {
    const g = equivalenceGuard(parseSync('SELECT * FROM t ORDER BY a LIMIT 20'), NO_VOLATILE);
    assert.equal(g.checkable, false);
    assert.match((g as { reason: string }).reason, /tie-breaking/);
  });

  test('OFFSET refuses the same way', () => {
    const g = equivalenceGuard(parseSync('SELECT * FROM t OFFSET 100'), NO_VOLATILE);
    assert.equal(g.checkable, false);
  });

  test('a volatile function refuses by name', () => {
    const g = equivalenceGuard(parseSync('SELECT * FROM t WHERE r < random()'), new Set(['random']));
    assert.equal(g.checkable, false);
    assert.match((g as { reason: string }).reason, /random\(\).*volatile/);
  });

  test('stable functions pass: now() inside one transaction is one value', () => {
    const g = equivalenceGuard(parseSync('SELECT * FROM t WHERE ts < now()'), NO_VOLATILE);
    assert.equal(g.checkable, true);
  });

  test('non-SELECT refuses', () => {
    const g = equivalenceGuard(parseSync("UPDATE t SET a = 1"), NO_VOLATILE);
    assert.equal(g.checkable, false);
  });
});

describe('function harvesting', () => {
  test('collects every call, unqualified by schema', () => {
    const names = harvestFunctionNames(parseSync(
      'SELECT lower(a), pg_catalog.date(b) FROM t WHERE random() < 0.5'));
    assert.deepEqual(names, ['date', 'lower', 'random']);
  });
});

describe('the comparison statement', () => {
  test('multiset semantics over both differences, one statement', () => {
    const c = buildComparisonSql('SELECT a FROM t', 'SELECT a FROM t2');
    const excepts = c.text.match(/EXCEPT ALL/g) ?? [];
    assert.equal(excepts.length, 2, 'both directions, EXCEPT ALL never EXCEPT');
    assert.match(c.text, /LIMIT 100001/);
    assert.equal(c.cap, 100_000);
  });

  test('trailing semicolons are stripped before embedding', () => {
    const c = buildComparisonSql('SELECT a FROM t;', 'SELECT a FROM t2 ;;');
    assert.doesNotMatch(c.text, /;\)/);
    assert.doesNotMatch(c.text, /; \)/);
  });

  test('the CTE prefix moves off any name the queries already use', () => {
    const c = buildComparisonSql('SELECT qn_a.x FROM qn_a', 'SELECT x FROM t');
    assert.notEqual(c.prefix, 'qn');
    assert.match(c.text, new RegExp(`WITH ${c.prefix}_a AS`));
  });

  test('the text fallback compares row text, and says which CTEs it reads', () => {
    const c = buildComparisonSql('SELECT a FROM t', 'SELECT a FROM t2', { asText: true });
    assert.match(c.text, /\(t\.\*\)::text/);
    assert.match(c.text, /TABLE qn_at/);
  });
});

describe('interpreting the counts', () => {
  test('zero in both directions is a match that says what it proved', () => {
    const r = interpretComparison({ a_rows: '31999', b_rows: '31999', only_in_a: '0', only_in_b: '0' }, 100_000, 'native');
    assert.equal(r.status, 'match');
    assert.equal(r.rowsOriginal, 31_999);
    assert.match(r.note, /on this data, not for all inputs/);
  });

  test('a difference is a mismatch with the counts and a do-not-apply', () => {
    const r = interpretComparison({ a_rows: '0', b_rows: '34399', only_in_a: '0', only_in_b: '34399' }, 100_000, 'native');
    assert.equal(r.status, 'mismatch');
    assert.equal(r.onlyInRewritten, 34_399);
    assert.match(r.note, /Do not apply/);
  });

  test('hitting the cap refuses rather than accuses', () => {
    // Both sides truncated at the cap are different arbitrary subsets; EXCEPT
    // ALL over them manufactures a mismatch that is not real. Refusal is the
    // only honest verdict.
    const r = interpretComparison({ a_rows: '100001', b_rows: '100001', only_in_a: '99212', only_in_b: '99212' }, 100_000, 'native');
    assert.equal(r.status, 'too-many-rows');
    assert.equal(r.onlyInOriginal, null, 'difference counts from truncated sets must not be reported');
    assert.match(r.note, /was not run/);
  });

  test('a text comparison says so in the note', () => {
    const r = interpretComparison({ a_rows: '3', b_rows: '3', only_in_a: '0', only_in_b: '0' }, 100_000, 'text');
    assert.match(r.note, /as text/);
  });
});
