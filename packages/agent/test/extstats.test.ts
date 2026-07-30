import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { parseExplainJson } from '@query-not/core';
import { initParser } from '../src/rewrite.ts';
import {
  buildAdviceDdl,
  buildDependencyEvidenceSql,
  buildProofDdl,
  buildStatisticsProbe,
  classifyOutcome,
  composeStatisticsNote,
  confirmConjunctionFromAst,
  interpretStatisticsProbe,
  parseDependencies,
  pickTargetNode,
  statisticsProbeUnavailable,
  validateStatisticsColumns,
  type StatisticsProbeCandidate,
  type StatisticsProbeRow,
} from '../src/statistics.ts';

before(async () => {
  await initParser();
});

const PAIR = ['country', 'currency'];

describe('confirmConjunctionFromAst', () => {
  test('a plain single-table conjunction confirms, unqualified', () => {
    const check = confirmConjunctionFromAst(
      "SELECT count(*) FROM customers WHERE country = 'US' AND currency = 'USD'",
      'customers',
      'customers',
      PAIR,
    );
    assert.equal(check.verdict, 'confirmed');
    assert.deepEqual(check.columns, PAIR);
  });

  test('qualified columns confirm through the alias in a join scope', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country = 'US' AND c.currency = 'USD' AND o.status = 'x'",
      'customers',
      'c',
      PAIR,
    );
    assert.equal(check.verdict, 'confirmed');
  });

  test('unqualified columns do not confirm when the scope has two range vars', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE country = 'US' AND currency = 'USD'",
      'customers',
      'c',
      PAIR,
    );
    assert.equal(check.verdict, 'contradicted');
  });

  test('a top-level OR refuses — the columns are not a conjunction', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers WHERE country = 'US' OR currency = 'USD'",
      'customers',
      null,
      PAIR,
    );
    assert.equal(check.verdict, 'contradicted');
    assert.match(check.reason, /OR|conjunct/i);
  });

  test('equalities buried inside an OR arm refuse', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers WHERE (country = 'US' AND currency = 'USD') OR signed_up_at > now()",
      'customers',
      null,
      PAIR,
    );
    assert.equal(check.verdict, 'contradicted');
  });

  test('conjuncts spanning two relations refuse', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country = 'US' AND o.status = 'x'",
      'customers',
      'c',
      ['country', 'status'],
    );
    assert.equal(check.verdict, 'contradicted');
  });

  test('a bind-parameter right-hand side confirms', () => {
    const check = confirmConjunctionFromAst(
      'SELECT * FROM customers WHERE country = $1 AND currency = $2',
      'customers',
      null,
      PAIR,
    );
    assert.equal(check.verdict, 'confirmed');
  });

  test('column = other_column is not a dependency-fixable conjunct', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers WHERE country = currency AND currency = 'USD'",
      'customers',
      null,
      PAIR,
    );
    assert.equal(check.verdict, 'contradicted');
  });

  test('a correlated subquery scope resolves against its own FROM clause', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.country = 'US' AND c.currency = 'USD' AND c.id = o.customer_id)",
      'customers',
      'c',
      PAIR,
    );
    assert.equal(check.verdict, 'confirmed');
  });

  test('a relation nowhere in the SQL is unresolved, not contradicted', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM orders WHERE status = 'x'",
      'customers',
      null,
      PAIR,
    );
    assert.equal(check.verdict, 'unresolved');
    assert.match(check.reason, /view or CTE/);
  });

  test('AND of ANDs flattens — nesting does not hide conjuncts', () => {
    const check = confirmConjunctionFromAst(
      "SELECT * FROM customers WHERE (country = 'US' AND currency = 'USD') AND id > 5",
      'customers',
      null,
      PAIR,
    );
    assert.equal(check.verdict, 'confirmed');
  });
});

describe('buildStatisticsProbe', () => {
  test('one jsonb payload, per-candidate lateral best match, no version-specific columns', () => {
    const probe = buildStatisticsProbe([
      { relation: 'customers', columns: PAIR, ratio: 5 },
      { relation: 'Weird Name', columns: ['a', 'b'], ratio: 6 },
    ]);
    assert.deepEqual(JSON.parse(probe.values[0]), [
      { rel: 'customers', cols: PAIR },
      { rel: '"Weird Name"', cols: ['a', 'b'] },
    ]);
    assert.match(probe.text, /jsonb_array_elements\(\$1::jsonb\) WITH ORDINALITY/);
    assert.match(probe.text, /pg_statistic_ext s/);
    assert.match(probe.text, /pg_stats_ext v/);
    // PG15+ produces two rows per object (stxdinherit); aggregate, never select it.
    assert.match(probe.text, /bool_or/);
    assert.doesNotMatch(probe.text, /inherited/);
    assert.match(probe.text, /ORDER BY idx/);
  });
});

describe('interpretStatisticsProbe', () => {
  const candidate: StatisticsProbeCandidate = { relation: 'customers', columns: PAIR, ratio: 5 };
  const row = (over: Partial<StatisticsProbeRow>): StatisticsProbeRow => ({
    idx: 0,
    rel_exists: true,
    stats_schema: 'public',
    stats_name: 'customers_stats',
    stats_columns: PAIR,
    kinds: 'd,f',
    visible_rows: 1,
    populated: true,
    ...over,
  });

  test('no covering object → none, and the fresh DDL advice stands unchanged', () => {
    const [check] = interpretStatisticsProbe([candidate], []);
    assert.equal(check!.existingState, 'none');
    assert.equal(check!.existing, null);
    assert.equal(check!.ddlOverride, null);
  });

  test('definition present but never computed → not-analysed, advice becomes ANALYZE', () => {
    const [check] = interpretStatisticsProbe([candidate], [row({ populated: false })]);
    assert.equal(check!.existingState, 'not-analysed');
    assert.equal(check!.ddlOverride, 'ANALYZE customers;');
    assert.match(check!.existingAdvice ?? '', /never been computed/);
    assert.match(check!.existingAdvice ?? '', /`customers_stats`/);
  });

  test('populated across two stxdinherit rows → analysed, with hedged next levers', () => {
    const [check] = interpretStatisticsProbe([candidate], [row({ visible_rows: 2, populated: true })]);
    assert.equal(check!.existingState, 'analysed');
    assert.equal(check!.ddlOverride, null);
    assert.match(check!.existingAdvice ?? '', /5\.0x/);
    assert.match(check!.existingAdvice ?? '', /an estimate, not a measurement/);
    assert.match(check!.existingAdvice ?? '', /`mcv`|statistics target/);
  });

  test('kinds without f or m cannot inform WHERE selectivity → wrong-kind', () => {
    const [check] = interpretStatisticsProbe([candidate], [row({ kinds: 'd' })]);
    assert.equal(check!.existingState, 'wrong-kind');
    assert.match(check!.existingAdvice ?? '', /no ALTER STATISTICS/);
  });

  test('zero view rows for an existing definition → not-visible, never "not analysed"', () => {
    const [check] = interpretStatisticsProbe([candidate], [row({ visible_rows: 0, populated: null })]);
    assert.equal(check!.existingState, 'not-visible');
    assert.match(check!.existingAdvice ?? '', /privileges|row security/);
    assert.doesNotMatch(check!.existingAdvice ?? '', /not.{0,4}analysed/i);
  });

  test('a failed probe is unknown and says so, claiming nothing', () => {
    const check = statisticsProbeUnavailable('relation "pg_stats_ext" does not exist');
    assert.equal(check.existingState, 'unknown');
    assert.match(check.existingAdvice ?? '', /pg_stats_ext.*does not exist/);
    assert.match(check.existingAdvice ?? '', /no claim/);
  });
});

describe('proof plumbing', () => {
  test('column validation enforces the 2..8 window and plain distinct names', () => {
    assert.equal(validateStatisticsColumns(PAIR).ok, true);
    assert.equal(validateStatisticsColumns(['one']).ok, false);
    assert.equal(validateStatisticsColumns(Array.from({ length: 9 }, (_, i) => `c${i}`)).ok, false);
    assert.equal(validateStatisticsColumns(['a', 'a']).ok, false);
    assert.equal(validateStatisticsColumns(['a', 42]).ok, false);
    assert.equal(validateStatisticsColumns('country,currency').ok, false);
  });

  test('proof DDL uses the fixed rolled-back name and quotes what needs quoting', () => {
    const ddl = buildProofDdl('Orders', ['Country', 'currency']);
    assert.equal(
      ddl.create,
      'CREATE STATISTICS qn_proof_stats (dependencies, ndistinct) ON "Country", currency FROM "Orders"',
    );
    assert.equal(ddl.analyze, 'ANALYZE "Orders"');
  });

  test('advice DDL is the durable named object plus its ANALYZE', () => {
    const ddl = buildAdviceDdl('customers', PAIR);
    assert.equal(
      ddl,
      'CREATE STATISTICS customers_country_currency_stats (dependencies, ndistinct) ON country, currency FROM customers;\nANALYZE customers;',
    );
  });

  test('the dependency evidence query is parameterised on the proof name', () => {
    const sql = buildDependencyEvidenceSql();
    assert.match(sql.text, /pg_stats_ext/);
    assert.match(sql.text, /stxname = \$1/);
    assert.deepEqual(sql.values, ['qn_proof_stats']);
  });

  test('parseDependencies maps attnums to column names positionally', () => {
    const pairs = parseDependencies('{"3 => 4": 1.000000, "4 => 3": 0.875000}', '3 4', PAIR);
    assert.deepEqual(pairs, [
      { determinant: ['country'], dependent: 'currency', degree: 1 },
      { determinant: ['currency'], dependent: 'country', degree: 0.875 },
    ]);
    // Multi-column determinants split on the comma.
    const multi = parseDependencies('{"1, 2 => 3": 0.5}', '1 2 3', ['a', 'b', 'c']);
    assert.deepEqual(multi, [{ determinant: ['a', 'b'], dependent: 'c', degree: 0.5 }]);
  });

  test('parseDependencies returns null rather than guessing on malformed input', () => {
    assert.equal(parseDependencies('not json', '3 4', PAIR), null);
    assert.equal(parseDependencies('{"9 => 4": 1}', '3 4', PAIR), null);
    assert.equal(parseDependencies(null, '3 4', PAIR), null);
    assert.equal(parseDependencies('{"3 => 4": 1}', '3 4', null), null);
  });

  test('outcome boundaries: fixed at <= 2x, improved when halved, else no effect', () => {
    const side = (ratio: number) => ({ estimatedRows: 1, actualRows: 1, ratio });
    assert.equal(classifyOutcome(side(5), side(2.0)), 'estimates-fixed');
    assert.equal(classifyOutcome(side(5), side(2.4)), 'estimates-improved');
    assert.equal(classifyOutcome(side(5), side(4.8)), 'no-effect');
    assert.equal(classifyOutcome(side(5), null), 'no-effect');
    assert.equal(classifyOutcome(null, side(1)), 'no-effect');
  });

  test('pickTargetNode scores column mentions and tie-breaks by misestimate', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Hash Join',
            'Plan Rows': 100,
            'Actual Rows': 100,
            'Actual Loops': 1,
            'Actual Total Time': 10,
            'Total Cost': 500,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'customers',
                Filter: "((country = 'US'::text) AND (currency = 'USD'::text))",
                'Plan Rows': 2000,
                'Actual Rows': 10000,
                'Actual Loops': 1,
                'Actual Total Time': 8,
                'Total Cost': 400,
              },
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'customers',
                Filter: "(id > 5)",
                'Plan Rows': 100,
                'Actual Rows': 100,
                'Actual Loops': 1,
                'Actual Total Time': 1,
                'Total Cost': 50,
              },
            ],
          },
          'Execution Time': 11,
        },
      ]),
    );
    const node = pickTargetNode(plan, 'customers', PAIR);
    assert.ok(node);
    assert.match(node.filter ?? '', /country/);
    assert.equal(pickTargetNode(plan, 'orders', PAIR), null);
  });

  test('the note names the sandbox, the rollback, and the lock caveat', () => {
    const note = composeStatisticsNote('querynot', 'customers');
    assert.match(note, /rolled back/);
    assert.match(note, /`querynot`/);
    assert.match(note, /ShareUpdateExclusive/);
    assert.match(note, /disposable database, never production/);
    assert.match(note, /cannot be\s+READ ONLY/);
  });
});
