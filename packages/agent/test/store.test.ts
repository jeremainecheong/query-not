import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store.ts';
import { buildHistory } from '../src/history.ts';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

/** A minimal but structurally real analysis payload. */
function payload(opts: {
  nodeType?: string;
  relation?: string;
  indexName?: string | null;
  cost?: number;
  ms?: number;
}) {
  const nodeType = opts.nodeType ?? 'Seq Scan';
  const cost = opts.cost ?? 1000;
  // Timing tracks cost unless overridden. Holding time constant while cost
  // swings produces a plan the diff engine correctly calls "restructured"
  // rather than "improved" — measured time is the primary signal, and it had
  // not moved. Realistic fixtures have to move both.
  const ms = opts.ms ?? cost / 20;
  return {
    plan: {
      root: {
        id: 'n0',
        nodeType,
        depth: 0,
        parentId: null,
        relationship: null,
        relation: opts.relation ?? 'orders',
        indexName: opts.indexName ?? null,
        cteName: null,
        functionName: null,
        joinType: null,
        startupCost: 0,
        totalCost: cost,
        planRows: 100,
        actualRows: 100,
        loops: 1,
        estimatedRowsTotal: 100,
        actualRowsTotal: 100,
        misestimate: 1,
        misestimateDirection: null,
        actualTotalTime: ms,
        inclusiveMs: ms,
        exclusiveMs: ms,
        neverExecuted: false,
        sortSpaceType: null,
        hashBatches: null,
        children: [],
      },
      nodes: [] as unknown[],
      analyzed: true,
      totalMs: ms,
      totalWorkMs: ms,
      totalCost: cost,
    },
  };
}

function record(fingerprint: string, opts: Parameters<typeof payload>[0] = {}) {
  const p = payload(opts);
  (p.plan.nodes as unknown[]) = [p.plan.root];
  return store.recordAnalysis({
    fingerprint,
    sql: 'select * from orders',
    analyzed: true,
    payload: p,
    totalMs: p.plan.totalMs,
    totalWorkMs: p.plan.totalWorkMs,
    totalCost: p.plan.totalCost,
  });
}

describe('analyses', () => {
  test('records and retrieves by slug', () => {
    const slug = record('fp1');
    assert.ok(slug.length >= 6, 'slug should be short but not trivially guessable');

    const found = store.getAnalysis(slug);
    assert.ok(found);
    assert.equal(found.fingerprint, 'fp1');
    assert.equal(found.sql, 'select * from orders');
    assert.equal(found.analyzed, true);
  });

  test('returns null for an unknown slug rather than throwing', () => {
    assert.equal(store.getAnalysis('nope'), null);
  });

  test('slugs are unique across runs', () => {
    const slugs = new Set(Array.from({ length: 50 }, () => record('fp1')));
    assert.equal(slugs.size, 50);
  });

  test('history is newest first', () => {
    const first = record('fp1', { cost: 100 });
    const second = record('fp1', { cost: 200 });
    const history = store.historyFor('fp1');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.slug, second);
    assert.equal(history[1]?.slug, first);
  });

  test('history is scoped to one query', () => {
    record('fp1');
    record('fp2');
    assert.equal(store.historyFor('fp1').length, 1);
    assert.equal(store.historyFor('fp2').length, 1);
  });

  test('prunes to the retention limit, keeping the newest', () => {
    const small = new Store(':memory:', { historyPerQuery: 3 });
    const slugs = [];
    for (let i = 0; i < 6; i++) {
      const p = payload({ cost: i });
      (p.plan.nodes as unknown[]) = [p.plan.root];
      slugs.push(
        small.recordAnalysis({
          fingerprint: 'fp',
          sql: 'q',
          analyzed: true,
          payload: p,
          totalMs: 1,
          totalWorkMs: 1,
          totalCost: i,
        }),
      );
    }
    const kept = small.historyFor('fp').map((h) => h.slug);
    assert.equal(kept.length, 3);
    // The three most recent survive; the oldest are gone.
    assert.equal(kept.includes(slugs[5] as string), true);
    assert.equal(kept.includes(slugs[0] as string), false);
    small.close();
  });

  test('recent analyses span queries', () => {
    record('fp1');
    record('fp2');
    assert.equal(store.recentAnalyses().length, 2);
  });
});

describe('saved queries', () => {
  test('saves and lists', () => {
    store.saveQuery('checkout', 'SELECT 1', 'fp1');
    const list = store.listSavedQueries();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, 'checkout');
  });

  test('re-saving the same name updates rather than duplicating', () => {
    store.saveQuery('checkout', 'SELECT 1', 'fp1');
    store.saveQuery('checkout', 'SELECT 2', 'fp2');
    const list = store.listSavedQueries();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.sql, 'SELECT 2');
    assert.equal(list[0]?.fingerprint, 'fp2');
  });

  test('links a saved query to its latest run and run count', () => {
    record('fp1');
    record('fp1');
    const saved = store.saveQuery('checkout', 'select * from orders', 'fp1');
    assert.equal(saved.runCount, 2);
    assert.ok(saved.latestSlug, 'a saved query with runs should link to the newest');
  });

  test('a saved query with no runs yet is still valid', () => {
    const saved = store.saveQuery('untried', 'SELECT 1', 'fp-none');
    assert.equal(saved.runCount, 0);
    assert.equal(saved.latestSlug, null);
  });

  test('deletes, and reports whether anything was deleted', () => {
    store.saveQuery('checkout', 'SELECT 1', 'fp1');
    assert.equal(store.deleteSavedQuery('checkout'), true);
    assert.equal(store.deleteSavedQuery('checkout'), false);
    assert.equal(store.listSavedQueries().length, 0);
  });
});

describe('decisions', () => {
  const base = {
    analysisSlug: null,
    fingerprint: 'fp1',
    kind: 'index' as const,
    change: 'CREATE INDEX ON orders (status)',
    verdict: 'improved',
    headline: 'Estimated cost fell by 84%',
    costBefore: 10559,
    costAfter: 1638,
    costOnly: true,
  };

  test('records what was tested and what it concluded', () => {
    const d = store.recordDecision(base);
    assert.equal(d.verdict, 'improved');
    assert.equal(d.costOnly, true);
    assert.equal(d.applied, false, 'a decision starts untested in production');
  });

  test('lists per query and globally', () => {
    store.recordDecision(base);
    store.recordDecision({ ...base, fingerprint: 'fp2' });
    assert.equal(store.listDecisions('fp1').length, 1);
    assert.equal(store.listDecisions().length, 2);
  });

  test('can be marked as actually shipped', () => {
    const d = store.recordDecision(base);
    const updated = store.markDecisionApplied(d.id, true);
    assert.equal(updated?.applied, true);
  });

  test('marking an unknown decision returns null', () => {
    assert.equal(store.markDecisionApplied(9999, true), null);
  });
});

describe('plan history and regression detection', () => {
  test('reports no regression when the plan never changes', () => {
    record('fp1', { cost: 1000 });
    record('fp1', { cost: 1000 });
    const report = buildHistory(store, 'fp1');
    assert.equal(report.points.length, 2);
    assert.equal(report.regressions.length, 0);
    assert.match(report.summary as string, /has not changed shape/);
  });

  test('detects a plan flipping from an index scan to a sequential scan', () => {
    // The exact case this feature exists for: the query did not change, the
    // data underneath it did.
    record('fp1', { nodeType: 'Index Scan', indexName: 'orders_status_idx', cost: 8 });
    record('fp1', { nodeType: 'Seq Scan', indexName: null, cost: 9000 });

    const report = buildHistory(store, 'fp1');
    assert.equal(report.regressions.length, 1);

    const r = report.regressions[0];
    assert.ok(r);
    assert.equal(r.worse, true);
    assert.equal(r.verdict, 'regressed');
    assert.ok(r.accessChanges.some((c) => /Index Scan → Seq Scan/.test(c)),
      `expected an access-method change, got: ${r.accessChanges.join('; ')}`);
    assert.ok(r.costAfter > r.costBefore);
  });

  test('an improvement is recorded but not flagged as worse', () => {
    record('fp1', { nodeType: 'Seq Scan', cost: 9000 });
    record('fp1', { nodeType: 'Index Scan', indexName: 'idx', cost: 8 });
    const report = buildHistory(store, 'fp1');
    assert.equal(report.regressions.length, 1);
    assert.equal(report.regressions[0]?.worse, false);
    assert.equal(report.regressions[0]?.verdict, 'improved');
  });

  test('compares each snapshot to the previous one, not to the first', () => {
    // Three distinct plans should yield two transitions, so the history says
    // *when* each change happened rather than one cumulative verdict.
    record('fp1', { nodeType: 'Index Scan', indexName: 'idx', cost: 10 });
    record('fp1', { nodeType: 'Bitmap Heap Scan', cost: 500 });
    record('fp1', { nodeType: 'Seq Scan', cost: 9000 });
    const report = buildHistory(store, 'fp1');
    assert.equal(report.points.length, 3);
    assert.equal(report.regressions.length, 2);
  });

  test('a single run reports a baseline rather than an empty history', () => {
    record('fp1');
    const report = buildHistory(store, 'fp1');
    assert.equal(report.points.length, 1);
    assert.equal(report.regressions.length, 0);
    assert.match(report.summary as string, /baseline/i);
  });

  describe('timing noise must not read as a regression', () => {
    // Regression, found by running the same query three times against a live
    // database: wall-clock varies run to run, and a time-led verdict reported
    // "the plan got worse" twice for three identical runs. History keys off
    // structure and cost, both deterministic given the data.
    test('identical plans with different timings report nothing', () => {
      record('fp1', { nodeType: 'Seq Scan', cost: 1000, ms: 50 });
      record('fp1', { nodeType: 'Seq Scan', cost: 1000, ms: 78 });
      record('fp1', { nodeType: 'Seq Scan', cost: 1000, ms: 41 });

      const report = buildHistory(store, 'fp1');
      assert.equal(report.points.length, 3);
      assert.equal(
        report.regressions.length,
        0,
        `run-to-run timing noise must not be reported: ${report.regressions.map((r) => r.headline).join('; ')}`,
      );
      assert.match(report.summary as string, /has not changed shape/);
    });

    test('a cost change is still caught even when timing barely moves', () => {
      // Cost is the planner's opinion and only moves when the statistics or
      // data do — the event actually worth surfacing.
      record('fp1', { nodeType: 'Seq Scan', cost: 1000, ms: 50 });
      record('fp1', { nodeType: 'Seq Scan', cost: 9000, ms: 51 });
      assert.equal(buildHistory(store, 'fp1').regressions.length, 1);
    });

    test('a structural change is caught even at identical cost', () => {
      record('fp1', { nodeType: 'Seq Scan', cost: 1000, ms: 50 });
      record('fp1', { nodeType: 'Index Scan', indexName: 'idx', cost: 1000, ms: 50 });
      const regressions = buildHistory(store, 'fp1').regressions;
      assert.equal(regressions.length, 1);
      assert.equal(regressions[0]?.verdict, 'restructured');
      assert.equal(regressions[0]?.worse, false);
    });
  });

  test('an unknown query yields an empty report, not an error', () => {
    const report = buildHistory(store, 'never-seen');
    assert.equal(report.points.length, 0);
    assert.equal(report.summary, null);
  });

  test('the summary names the worst regression', () => {
    record('fp1', { nodeType: 'Index Scan', indexName: 'idx', cost: 10 });
    record('fp1', { nodeType: 'Seq Scan', cost: 9000 });
    const summary = buildHistory(store, 'fp1').summary as string;
    assert.match(summary, /got worse/);
    // The explanation matters as much as the detection.
    assert.match(summary, /data or the statistics moved/);
  });

  test('history points expose the access methods used', () => {
    record('fp1', { nodeType: 'Index Scan', indexName: 'orders_pkey' });
    const point = buildHistory(store, 'fp1').points[0];
    assert.ok(point);
    assert.ok(point.accessMethods.some((m) => m.includes('orders_pkey')));
  });
});

describe('stats', () => {
  test('counts distinct queries, not just runs', () => {
    record('fp1');
    record('fp1');
    record('fp2');
    store.saveQuery('a', 'SELECT 1', 'fp1');
    const stats = store.stats();
    assert.equal(stats.analyses, 3);
    assert.equal(stats.queries, 2);
    assert.equal(stats.savedQueries, 1);
  });
});
