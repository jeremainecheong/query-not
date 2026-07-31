import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExplainJson } from '../src/parse.ts';
import {
  analyze,
  composeExtendedStatisticsDdl,
  suggestExtendedStatistics,
  suggestIndexes,
} from '../src/analyze.ts';
import type { Finding, FindingKind, QueryPlan } from '../src/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): QueryPlan {
  return parseExplainJson(readFileSync(join(FIXTURES, name), 'utf8'));
}

function kinds(findings: Finding[]): FindingKind[] {
  return findings.map((f) => f.kind);
}

describe('analyze', () => {
  test('detects a disk spill and names a concrete work_mem value', () => {
    const findings = analyze(loadFixture('disk-sort.json'));
    const spill = findings.find((f) => f.kind === 'sort-spilled-to-disk');

    assert.ok(spill, `expected a spill finding, got: ${kinds(findings).join(', ')}`);
    assert.equal(spill.severity, 'critical');
    assert.ok(spill.suggestion, 'a spill has a knowable fix, so it must carry a suggestion');
    assert.match(spill.suggestion, /work_mem/);
    // The suggestion must be a value someone can paste, not "increase work_mem".
    assert.match(spill.suggestion, /\d+(MB|GB)/);
    assert.ok(spill.evidence['diskUsed']);
  });

  test('detects the sequential-scan-discards-everything shape', () => {
    const findings = analyze(loadFixture('seq-scan-filter.json'));
    const waste = findings.find((f) => f.kind === 'seq-scan-candidate');

    assert.ok(waste, `expected a seq scan finding, got: ${kinds(findings).join(', ')}`);
    const discarded = String(waste.evidence['discarded']);
    assert.ok(discarded, 'the finding must report how much was discarded');
    assert.ok(
      Number.parseFloat(discarded) >= 99,
      `expected an overwhelming discard rate, got ${discarded}`,
    );
    // It kept 801 rows, so it did not discard *everything* — the copy must not say it did.
    assert.notEqual(discarded, '100%');
  });

  test('detects a large cardinality misestimate and explains the direction', () => {
    const findings = analyze(loadFixture('misestimate.json'));
    const mis = findings.find((f) => f.kind === 'cardinality-misestimate');

    assert.ok(mis, `expected a misestimate finding, got: ${kinds(findings).join(', ')}`);
    assert.equal(mis.evidence['direction'], 'under');
    // Underestimates are the dangerous direction and the copy must say why.
    assert.match(mis.detail, /nested loop|catastrophic|dangerous/i);
    assert.match(mis.suggestion as string, /ANALYZE|STATISTICS/);
  });

  test('ranks findings by time impact, not by rule order', () => {
    const findings = analyze(loadFixture('disk-sort.json'));
    for (let i = 1; i < findings.length; i++) {
      const prev = findings[i - 1] as Finding;
      const cur = findings[i] as Finding;
      assert.ok(
        prev.impactMs >= cur.impactMs,
        `findings out of order: ${prev.kind}(${prev.impactMs}) before ${cur.kind}(${cur.impactMs})`,
      );
    }
  });

  test('flags an un-analyzed plan rather than silently reporting estimates as fact', () => {
    const findings = analyze(loadFixture('not-analyzed.json'));
    const notAnalyzed = findings.find((f) => f.kind === 'not-analyzed');

    assert.ok(notAnalyzed);
    assert.match(notAnalyzed.suggestion as string, /executes the query/);
    // No measurement-based finding may appear without measurements.
    assert.equal(findings.some((f) => f.kind === 'cardinality-misestimate'), false);
    assert.equal(findings.some((f) => f.kind === 'sort-spilled-to-disk'), false);
  });

  test('suppresses a generic hotspot when a specific diagnosis exists for that node', () => {
    const plan = loadFixture('disk-sort.json');
    const findings = analyze(plan);
    const specific = new Set(
      findings.filter((f) => f.kind !== 'time-hotspot').map((f) => f.nodeId),
    );
    for (const f of findings) {
      if (f.kind === 'time-hotspot') {
        assert.equal(specific.has(f.nodeId), false, 'hotspot duplicated a specific finding');
      }
    }
  });

  test('never emits a finding for a node that never executed', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Nested Loop',
            'Total Cost': 10,
            'Plan Rows': 1,
            'Actual Rows': 0,
            'Actual Loops': 1,
            'Actual Total Time': 0.1,
            Plans: [
              {
                'Node Type': 'Seq Scan',
                'Relation Name': 'skipped',
                'Plan Rows': 100000,
                'Actual Rows': 0,
                'Actual Loops': 0,
                'Total Cost': 5000,
              },
            ],
          },
        },
      ]),
    );
    const skipped = plan.nodes.find((n) => n.relation === 'skipped');
    const findings = analyze(plan);
    assert.equal(findings.some((f) => f.nodeId === skipped?.id), false);
  });

  test('produces no critical findings on a healthy plan', () => {
    // A well-estimated aggregate over indexed joins should stay quiet.
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Aggregate',
            'Total Cost': 100,
            'Plan Rows': 1,
            'Actual Rows': 1,
            'Actual Loops': 1,
            'Actual Total Time': 5,
            Plans: [
              {
                'Node Type': 'Index Scan',
                'Relation Name': 'orders',
                'Index Name': 'orders_pkey',
                'Plan Rows': 100,
                'Actual Rows': 105,
                'Actual Loops': 1,
                'Actual Total Time': 4,
                'Total Cost': 90,
              },
            ],
          },
          'Execution Time': 5.2,
        },
      ]),
    );
    const findings = analyze(plan);
    assert.equal(
      findings.filter((f) => f.severity === 'critical').length,
      0,
      `healthy plan produced criticals: ${kinds(findings).join(', ')}`,
    );
  });
});

describe('suggestIndexes', () => {
  test('proposes an index for a wasteful sequential scan', () => {
    const suggestions = suggestIndexes(loadFixture('seq-scan-filter.json'));
    assert.ok(suggestions.length > 0, 'expected at least one index suggestion');

    const s = suggestions[0];
    assert.ok(s);
    assert.equal(s.relation, 'orders');
    assert.match(s.ddl, /^CREATE INDEX CONCURRENTLY ON orders \(/);
    assert.ok(s.columns.includes('status'), `expected status in ${s.columns.join(',')}`);
  });

  test('orders equality columns before range columns', () => {
    // (status = 'x' AND created_at > '...') must yield (status, created_at):
    // the reverse can only use its leading column as a scan boundary.
    const suggestions = suggestIndexes(loadFixture('seq-scan-filter.json'));
    const s = suggestions.find((x) => x.columns.includes('created_at'));
    if (s) {
      assert.equal(
        s.columns.indexOf('status') < s.columns.indexOf('created_at'),
        true,
        `equality column must lead: got (${s.columns.join(', ')})`,
      );
    }
  });

  test('warns when a predicate wraps the column in a function', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            Filter: "(date(created_at) = '2024-01-01'::date)",
            'Rows Removed by Filter': 500000,
            'Plan Rows': 100,
            'Actual Rows': 12,
            'Actual Loops': 1,
            'Actual Total Time': 200,
            'Total Cost': 9000,
          },
          'Execution Time': 210,
        },
      ]),
    );
    const suggestions = suggestIndexes(plan);
    const s = suggestions[0];
    assert.ok(s, 'expected a suggestion');
    assert.equal(s.confidence, 'low');
    assert.ok(s.caveat, 'a function-wrapped column must carry a caveat, not silent bad advice');
    assert.match(s.caveat, /expression index|rewrite/i);
  });

  test('does not suggest an index for a scan that keeps most of what it reads', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            Filter: '(total_cents > 0)',
            'Rows Removed by Filter': 5,
            'Plan Rows': 100000,
            'Actual Rows': 99995,
            'Actual Loops': 1,
            'Actual Total Time': 50,
            'Total Cost': 900,
          },
          'Execution Time': 55,
        },
      ]),
    );
    assert.equal(suggestIndexes(plan).length, 0, 'an unselective filter is not an index candidate');
  });

  test('deduplicates identical suggestions across nodes', () => {
    const suggestions = suggestIndexes(loadFixture('join-agg.json'));
    const keys = suggestions.map((s) => `${s.relation}(${s.columns.join(',')})`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('suggestExtendedStatistics', () => {
  /** An ANALYZEd single-scan plan with the given quals and cardinalities. */
  function scanPlan(over: Record<string, unknown> = {}, analyzed = true): QueryPlan {
    return parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Seq Scan',
            'Relation Name': 'customers',
            Filter: "((country = 'DE'::text) AND (currency = 'EUR'::text))",
            'Plan Rows': 2000,
            ...(analyzed ? { 'Actual Rows': 10000, 'Actual Loops': 1, 'Actual Total Time': 12 } : {}),
            'Total Cost': 1218,
            ...over,
          },
          ...(analyzed ? { 'Execution Time': 13 } : {}),
        },
      ]),
    );
  }

  test('the correlated-pair underestimate produces exactly one suggestion with the ratio cited', () => {
    const suggestions = suggestExtendedStatistics(scanPlan());
    assert.equal(suggestions.length, 1);
    const s = suggestions[0]!;
    assert.equal(s.relation, 'customers');
    assert.deepEqual(s.columns, ['country', 'currency']);
    assert.equal(
      s.ddl,
      'CREATE STATISTICS customers_country_currency_stats (dependencies, ndistinct) ON country, currency FROM customers;',
    );
    assert.equal(s.ratio, 5);
    assert.equal(s.estimatedRows, 2000);
    assert.equal(s.actualRows, 10000);
    assert.equal(s.confidence, 'high');
    // The evidence must cite the measured ratio and both columns, backticked.
    assert.match(s.reason, /5\.0x under/);
    assert.match(s.reason, /`country`/);
    assert.match(s.reason, /`currency`/);
    assert.match(s.reason, /pg_statistic_ext/);
  });

  test('the gate admits ANALYZE sampling error around the 5x bar, and nothing below it', () => {
    // The seeded demo's true 5x dependency samples at ~4.9x; it must fire.
    const sampled = scanPlan({ 'Plan Rows': 2036 }); // 10000 / 2036 = 4.91x
    assert.equal(suggestExtendedStatistics(sampled).length, 1);
    // 3.9x is imprecision territory, not a dependency signature.
    const below = scanPlan({ 'Plan Rows': 2564 }); // 10000 / 2564 = 3.90x
    assert.equal(suggestExtendedStatistics(below).length, 0);
  });

  test('refuses a single equality column', () => {
    const plan = scanPlan({ Filter: "(country = 'DE'::text)" });
    assert.equal(suggestExtendedStatistics(plan).length, 0);
  });

  test('refuses an overestimate — dependencies can only raise estimates', () => {
    const plan = scanPlan({ 'Plan Rows': 50000 }); // 5x over
    assert.equal(suggestExtendedStatistics(plan).length, 0);
  });

  test('emits nothing for an un-analyzed plan', () => {
    assert.equal(suggestExtendedStatistics(scanPlan({}, false)).length, 0);
  });

  test('refuses when the predicate contains an OR — a disjunction is not a conjunction', () => {
    const plan = scanPlan({
      Filter: "(((country = 'DE'::text) AND (currency = 'EUR'::text)) OR (country = 'JP'::text))",
    });
    assert.equal(suggestExtendedStatistics(plan).length, 0);
  });

  test('a function-wrapped column is excluded, and the pair collapsing below two refuses', () => {
    const plan = scanPlan({
      Filter: "((date(signed_up_at) = '2024-01-01'::date) AND (country = 'DE'::text))",
    });
    assert.equal(suggestExtendedStatistics(plan).length, 0);
  });

  test('refuses more than eight equality columns — the CREATE STATISTICS limit', () => {
    const filter = `(${Array.from({ length: 9 }, (_, i) => `(c${i} = ${i})`).join(' AND ')})`;
    assert.equal(suggestExtendedStatistics(scanPlan({ Filter: filter })).length, 0);
  });

  test('deduplicates the same relation and column set across nodes', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Append',
            'Plan Rows': 4000,
            'Actual Rows': 20000,
            'Actual Loops': 1,
            'Actual Total Time': 25,
            'Total Cost': 2500,
            Plans: [0, 1].map(() => ({
              'Node Type': 'Seq Scan',
              'Relation Name': 'customers',
              Filter: "((country = 'DE'::text) AND (currency = 'EUR'::text))",
              'Plan Rows': 2000,
              'Actual Rows': 10000,
              'Actual Loops': 1,
              'Actual Total Time': 12,
              'Total Cost': 1218,
            })),
          },
          'Execution Time': 26,
        },
      ]),
    );
    assert.equal(suggestExtendedStatistics(plan).length, 1);
  });

  test('quotes identifiers that need it, and hashes a name that overflows 63 bytes', () => {
    const short = composeExtendedStatisticsDdl('Orders', ['Country', 'currency']);
    assert.match(short.ddl, /^CREATE STATISTICS "Orders_Country_currency_stats" \(dependencies, ndistinct\) ON "Country", currency FROM "Orders";$/);

    const longCols = ['a_very_long_column_name_one', 'a_very_long_column_name_two', 'a_very_long_column_name_three'];
    const long = composeExtendedStatisticsDdl('a_rather_long_relation_name', longCols);
    assert.ok(Buffer.byteLength(long.statName, 'utf8') <= 63, `name too long: ${long.statName}`);
    assert.match(long.statName, /_[0-9a-f]{8}$/);
    // Distinct long names must not collide after truncation.
    const sibling = composeExtendedStatisticsDdl('a_rather_long_relation_name', [...longCols.slice(0, 2), 'a_very_long_column_name_four']);
    assert.notEqual(long.statName, sibling.statName);
  });
});
