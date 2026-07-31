/**
 * Consolidation tests — the pure merge and demand extraction.
 *
 * The merge's one honesty invariant: a candidate claims a demand only when
 * `serves` accepts it structurally (equality set is exactly the index prefix,
 * range immediately after). Every case below is a shape the algorithm must
 * either merge, refuse to merge, or refuse loudly (omitted/standalone) —
 * silent loss is the only wrong answer.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseExplainJson } from '../src/parse.ts';
import {
  consolidateDemands,
  extractIndexDemands,
  serves,
  type WeightedDemand,
} from '../src/consolidate.ts';

function wd(
  relation: string,
  equality: string[],
  range: string | null,
  queries: Array<[string, number]>,
): WeightedDemand {
  return {
    relation,
    equality,
    range,
    queries: queries.map(([fingerprint, weight]) => ({ fingerprint, weight })),
  };
}

describe('serves', () => {
  const columns = ['a', 'b', 'c'];

  test('a prefix of the columns is full service, in any equality order', () => {
    assert.equal(serves(columns, { equality: ['a'], range: null }), true);
    assert.equal(serves(columns, { equality: ['a', 'b'], range: null }), true);
    assert.equal(serves(columns, { equality: ['b', 'a'], range: null }), true);
    assert.equal(serves(columns, { equality: ['a', 'b', 'c'], range: null }), true);
  });

  test('a range column counts only immediately after the equality prefix', () => {
    assert.equal(serves(columns, { equality: ['a'], range: 'b' }), true);
    assert.equal(serves(columns, { equality: ['a', 'b'], range: 'c' }), true);
    // The range column exists in the index but not at the position a b-tree
    // could use as a scan boundary — that is not service.
    assert.equal(serves(columns, { equality: ['a'], range: 'c' }), false);
  });

  test('a non-prefix equality set is not served', () => {
    assert.equal(serves(columns, { equality: ['b'], range: null }), false);
    assert.equal(serves(columns, { equality: ['c'], range: null }), false);
    assert.equal(serves(columns, { equality: ['a', 'c'], range: null }), false);
  });

  test('an equality-less range demand needs the range column leading', () => {
    assert.equal(serves(['b'], { equality: [], range: 'b' }), true);
    assert.equal(serves(['a', 'b'], { equality: [], range: 'b' }), false);
  });

  test('trailing extra columns do not defeat service', () => {
    assert.equal(serves(['a', 'b', 'c', 'd'], { equality: ['a', 'b'], range: 'c' }), true);
  });
});

describe('consolidateDemands — the merge', () => {
  test('an equality subset folds into the wider demand as its prefix', () => {
    const { candidates, standalone } = consolidateDemands([
      wd('orders', ['a'], null, [['q1', 0.3]]),
      wd('orders', ['a', 'b'], null, [['q2', 0.2]]),
    ]);
    assert.equal(candidates.length, 1);
    assert.equal(standalone.length, 0);
    const c = candidates[0];
    assert.ok(c);
    assert.deepEqual(c.columns, ['a', 'b']);
    assert.deepEqual(c.roles, ['eq', 'eq']);
    assert.deepEqual([...c.claims].sort(), ['q1', 'q2']);
    assert.ok(Math.abs(c.weight - 0.5) < 1e-9);
  });

  test('the classic consolidation: eq{a}+range b folds under eq{a,b}+range c', () => {
    // Demand 1 needs b right after a (its range); demand 2 needs {a,b} as the
    // prefix and c after it. One index satisfies both: (a, b, c).
    const { candidates } = consolidateDemands([
      wd('orders', ['a'], 'b', [['q1', 0.3]]),
      wd('orders', ['a', 'b'], 'c', [['q2', 0.2]]),
    ]);
    assert.equal(candidates.length, 1);
    const c = candidates[0];
    assert.ok(c);
    assert.deepEqual(c.columns, ['a', 'b', 'c']);
    assert.deepEqual(c.roles, ['eq', 'eq', 'range']);
    assert.deepEqual([...c.claims].sort(), ['q1', 'q2']);
    // Demand 1's own per-query index (a, b) becomes redundant; demand 2's is
    // this very index, so only one replacement is reported.
    assert.deepEqual(c.replaces, [{ relation: 'orders', columns: ['a', 'b'] }]);
  });

  test('disjoint equality sets never merge', () => {
    const { candidates } = consolidateDemands([
      wd('t', ['a'], null, [['q1', 0.3], ['q2', 0.1]]),
      wd('t', ['b'], null, [['q3', 0.2], ['q4', 0.1]]),
    ]);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((c) => c.columns), [['a'], ['b']]);
  });

  test('a pin that cannot sit in the next block keeps the demands apart', () => {
    // eq{a}+range b requires b at position 1; the only compatible block there
    // is {c}. Merging would break demand 1, so it must not happen.
    const { candidates } = consolidateDemands([
      wd('t', ['a'], 'b', [['q1', 0.4], ['q2', 0.2]]),
      wd('t', ['a', 'c'], null, [['q3', 0.3], ['q4', 0.1]]),
    ]);
    assert.equal(candidates.length, 2);
    const cols = candidates.map((c) => c.columns.join(','));
    assert.ok(cols.includes('a,b'), cols.join(' | '));
    assert.ok(cols.includes('a,c'), cols.join(' | '));
  });

  test('the same equality set with different ranges stays two indexes', () => {
    // Only the column immediately after the prefix bounds a scan; one index
    // cannot put both b and c there.
    const { candidates } = consolidateDemands([
      wd('t', ['a'], 'b', [['q1', 0.4], ['q2', 0.2]]),
      wd('t', ['a'], 'c', [['q3', 0.3], ['q4', 0.1]]),
    ]);
    assert.equal(candidates.length, 2);
    for (const c of candidates) {
      assert.equal(c.claims.length, 2, `each candidate claims only its own pair: ${c.columns.join(',')}`);
    }
  });

  test('two different same-size equality sets never merge', () => {
    const { candidates } = consolidateDemands([
      wd('t', ['a', 'b'], null, [['q1', 0.4], ['q2', 0.2]]),
      wd('t', ['a', 'c'], null, [['q3', 0.3], ['q4', 0.1]]),
    ]);
    assert.equal(candidates.length, 2);
  });

  test('relations never mix', () => {
    const { candidates } = consolidateDemands([
      wd('orders', ['a'], null, [['q1', 0.4], ['q2', 0.2]]),
      wd('customers', ['a'], null, [['q3', 0.3], ['q4', 0.1]]),
    ]);
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((c) => c.relation).sort(), ['customers', 'orders']);
  });
});

describe('consolidateDemands — determinism and honesty', () => {
  test('identical input produces deep-equal output', () => {
    const input = () => [
      wd('t', ['a'], 'b', [['q1', 0.3]]),
      wd('t', ['a', 'b'], 'c', [['q2', 0.2]]),
      wd('t', ['x'], null, [['q3', 0.1], ['q4', 0.05]]),
      wd('u', ['y'], null, [['q5', 0.2], ['q6', 0.1]]),
    ];
    assert.deepEqual(consolidateDemands(input()), consolidateDemands(input()));
  });

  test('within a block, ties break alphabetically', () => {
    // b and c enter at the same chain step. Every group member either contains
    // the whole step or none of it, so their workload weights tie by
    // construction and the name closes it — deterministically.
    const { candidates } = consolidateDemands([
      wd('t', ['a'], null, [['q1', 0.5]]),
      wd('t', ['a', 'c', 'b'], null, [['q2', 0.2]]),
    ]);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.columns, ['a', 'b', 'c']);
  });

  test('candidates sort by weight, then width, then ddl', () => {
    const { candidates } = consolidateDemands([
      wd('t', ['a'], null, [['q1', 0.1], ['q2', 0.1]]),
      wd('t', ['b'], null, [['q3', 0.5], ['q4', 0.1]]),
    ]);
    assert.deepEqual(candidates.map((c) => c.columns), [['b'], ['a']]);
  });

  test('maxColumns blocks a merge, but the sweep still claims what is served', () => {
    // The wider demand cannot join the (a,b) group under maxColumns 2, so it
    // opens its own group — whose columns still serve the narrower demand.
    // Grouping accidents must not narrow honest claims: the wide candidate
    // claims both queries, and the narrow group — left covering one query,
    // one demand — correctly demotes to standalone.
    const { candidates, standalone } = consolidateDemands(
      [
        wd('t', ['a', 'b'], null, [['q1', 0.5]]),
        wd('t', ['a', 'b', 'c'], null, [['q2', 0.2]]),
      ],
      { maxColumns: 2 },
    );
    assert.equal(candidates.length, 1);
    const wide = candidates[0];
    assert.ok(wide);
    assert.deepEqual(wide.columns, ['a', 'b', 'c']);
    assert.deepEqual([...wide.claims].sort(), ['q1', 'q2'], 'the wide index claims the narrow demand too');
    assert.deepEqual(standalone, [{ relation: 't', columns: ['a', 'b'], fingerprints: ['q1'] }]);
  });

  test('maxCandidates overflow is reported as omitted, never silently cut', () => {
    const { candidates, omitted } = consolidateDemands(
      [
        wd('t', ['a'], null, [['q1', 0.5], ['q2', 0.1]]),
        wd('t', ['b'], null, [['q3', 0.2], ['q4', 0.1]]),
      ],
      { maxCandidates: 1 },
    );
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.columns, ['a']);
    assert.equal(omitted.length, 1);
    assert.equal(omitted[0]?.relation, 't');
    assert.deepEqual(omitted[0]?.columns, ['b']);
    assert.ok(Math.abs((omitted[0]?.weight ?? 0) - 0.3) < 1e-9);
  });

  test('a single-demand single-query group is the per-query advisor\'s job', () => {
    const { candidates, standalone } = consolidateDemands([
      wd('t', ['a'], null, [['q1', 0.4]]),
    ]);
    assert.equal(candidates.length, 0);
    assert.deepEqual(standalone, [{ relation: 't', columns: ['a'], fingerprints: ['q1'] }]);
  });

  test('a single demand shared by two queries is worth consolidating', () => {
    const { candidates, standalone } = consolidateDemands([
      wd('t', ['a'], null, [['q1', 0.4], ['q2', 0.2]]),
    ]);
    assert.equal(standalone.length, 0);
    assert.equal(candidates.length, 1);
    assert.deepEqual([...(candidates[0]?.claims ?? [])].sort(), ['q1', 'q2']);
  });

  test('duplicate demands dedupe, counting each fingerprint once', () => {
    const { candidates } = consolidateDemands([
      wd('t', ['a'], null, [['q1', 0.3]]),
      wd('t', ['a'], null, [['q1', 0.3], ['q2', 0.2]]),
    ]);
    assert.equal(candidates.length, 1);
    assert.ok(Math.abs((candidates[0]?.weight ?? 0) - 0.5) < 1e-9, String(candidates[0]?.weight));
  });

  test('ddl quotes identifiers and keeps CONCURRENTLY for the human', () => {
    const { candidates } = consolidateDemands([
      wd('orders', ['status'], 'created_at', [['q1', 0.3], ['q2', 0.2]]),
    ]);
    assert.equal(
      candidates[0]?.ddl,
      'CREATE INDEX CONCURRENTLY ON orders (status, created_at);',
    );
    assert.match(candidates[0]?.rationale ?? '', /equality-first/);
  });
});

describe('extractIndexDemands', () => {
  function analyzedScan(filter: string, over: Record<string, unknown> = {}) {
    return parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            Filter: filter,
            'Rows Removed by Filter': 500000,
            'Plan Rows': 100,
            'Actual Rows': 12,
            'Actual Loops': 1,
            'Actual Total Time': 200,
            'Total Cost': 9000,
            ...over,
          },
          'Execution Time': 210,
        },
      ]),
    );
  }

  test('splits a filter into an equality prefix and one range column', () => {
    const demands = extractIndexDemands(
      analyzedScan("(((status)::text = 'x'::text) AND (created_at > '2024-01-01'::timestamptz))"),
    );
    assert.equal(demands.length, 1);
    const d = demands[0];
    assert.ok(d);
    assert.equal(d.relation, 'orders');
    assert.deepEqual(d.equality, ['status']);
    assert.equal(d.range, 'created_at');
    assert.deepEqual(d.dropped, []);
  });

  test('membership (= ANY) counts as equality', () => {
    const demands = extractIndexDemands(analyzedScan("(id = ANY ('{1,2,3}'::integer[]))"));
    assert.deepEqual(demands[0]?.equality, ['id']);
    assert.equal(demands[0]?.range, null);
  });

  test('a wrapped column is dropped with the reason, not silently claimed', () => {
    const demands = extractIndexDemands(
      analyzedScan("((date(created_at) = '2024-01-01'::date) AND ((status)::text = 'x'::text))"),
    );
    const d = demands[0];
    assert.ok(d);
    assert.deepEqual(d.equality, ['status']);
    assert.equal(d.range, null);
    assert.equal(d.dropped.length, 1);
    assert.match(d.dropped[0]?.reason ?? '', /expression-index/);
    assert.match(d.dropped[0]?.reason ?? '', /`date\(created_at\)`/);
  });

  test('a node with only unclaimable columns yields no demand', () => {
    const demands = extractIndexDemands(analyzedScan("((email)::text ~~ 'a%'::text)"));
    assert.deepEqual(demands, []);
  });

  test('the un-analyzed gate uses the estimate: planRows < totalCost', () => {
    const plan = (planRows: number) =>
      parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Relation Name': 'orders',
              Filter: "((status)::text = 'x'::text)",
              'Plan Rows': planRows,
              'Total Cost': 9000,
            },
          },
        ]),
      );
    assert.equal(extractIndexDemands(plan(100)).length, 1, 'selective estimate produces a demand');
    assert.equal(extractIndexDemands(plan(200000)).length, 0, 'an unselective filter does not');
  });

  test('an analyzed scan below the waste threshold produces no demand', () => {
    // 500 removed of 100k kept: nowhere near the 90% waste gate.
    const demands = extractIndexDemands(
      analyzedScan("((status)::text = 'x'::text)", {
        'Rows Removed by Filter': 500,
        'Actual Rows': 100000,
      }),
    );
    assert.deepEqual(demands, []);
  });

  test('only Seq Scan and Bitmap Heap Scan nodes are considered', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Index Scan',
            'Relation Name': 'orders',
            'Index Name': 'orders_pkey',
            Filter: "((status)::text = 'x'::text)",
            'Rows Removed by Filter': 500000,
            'Plan Rows': 100,
            'Actual Rows': 12,
            'Actual Loops': 1,
            'Total Cost': 9000,
          },
          'Execution Time': 210,
        },
      ]),
    );
    assert.deepEqual(extractIndexDemands(plan), []);
  });

  test('a Bitmap Heap Scan recheck condition is a demand source', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Bitmap Heap Scan',
            'Relation Name': 'orders',
            'Recheck Cond': "((status)::text = 'x'::text)",
            'Rows Removed by Filter': 500000,
            'Plan Rows': 100,
            'Actual Rows': 12,
            'Actual Loops': 1,
            'Total Cost': 9000,
          },
          'Execution Time': 210,
        },
      ]),
    );
    assert.deepEqual(extractIndexDemands(plan)[0]?.equality, ['status']);
  });

  test('a never-executed node yields no demand', () => {
    const demands = extractIndexDemands(
      analyzedScan("((status)::text = 'x'::text)", { 'Actual Loops': 0, 'Actual Rows': 0 }),
    );
    assert.deepEqual(demands, []);
  });
});
