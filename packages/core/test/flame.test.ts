import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExplainJson } from '../src/parse.ts';
import { layoutFlame, hotspots } from '../src/flame.ts';
import { narratePlan, narrateNode, explainNodeType } from '../src/narrate.ts';
import { formatMs, formatRows, suggestWorkMem, formatBytes, formatPercent } from '../src/format.ts';
import type { QueryPlan } from '../src/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): QueryPlan =>
  parseExplainJson(readFileSync(join(FIXTURES, name), 'utf8'));

describe('layoutFlame', () => {
  test('weights bars by exclusive time on an analyzed plan', () => {
    const layout = layoutFlame(load('join-agg.json'));
    assert.equal(layout.basis, 'time');
    assert.ok(layout.total > 0);
  });

  test('falls back to cost when the plan was not executed', () => {
    const layout = layoutFlame(load('not-analyzed.json'));
    assert.equal(layout.basis, 'cost');
    assert.ok(layout.total > 0);
  });

  test('the root spans the full width', () => {
    const layout = layoutFlame(load('join-agg.json'));
    const root = layout.cells.find((c) => c.depth === 0);
    assert.ok(root);
    assert.equal(root.x, 0);
    assert.ok(Math.abs(root.width - 1) < 1e-9, `root width was ${root.width}, expected 1`);
  });

  test('children fit inside their parent and never overflow', () => {
    // The invariant that makes the picture honest: if children could sum past
    // the parent, the bars would misrepresent where time went.
    for (const name of ['join-agg.json', 'disk-sort.json', 'nested-loop.json']) {
      const plan = load(name);
      const layout = layoutFlame(plan);
      const byId = new Map(layout.cells.map((c) => [c.nodeId, c]));

      for (const node of plan.nodes) {
        const cell = byId.get(node.id);
        if (!cell) continue;
        let childWidth = 0;
        for (const child of node.children) childWidth += byId.get(child.id)?.width ?? 0;
        assert.ok(
          childWidth <= cell.width + 1e-9,
          `${name}: children of ${node.nodeType} (${childWidth}) overflow parent (${cell.width})`,
        );
      }
    }
  });

  test('emits one cell per node', () => {
    const plan = load('join-agg.json');
    assert.equal(layoutFlame(plan).cells.length, plan.nodes.length);
  });

  test('never-executed nodes get zero width rather than being dropped', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Nested Loop', 'Total Cost': 10, 'Plan Rows': 1,
            'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 5,
            Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'skipped', 'Total Cost': 5, 'Plan Rows': 1, 'Actual Rows': 0, 'Actual Loops': 0 }],
          },
          'Execution Time': 5,
        },
      ]),
    );
    const layout = layoutFlame(plan);
    const skipped = layout.cells.find((c) => c.label.includes('skipped'));
    assert.ok(skipped);
    assert.equal(skipped.neverExecuted, true);
    assert.equal(skipped.width, 0);
  });
});

describe('hotspots', () => {
  test('ranks by self time, descending', () => {
    const ranked = hotspots(load('join-agg.json'), 5);
    for (let i = 1; i < ranked.length; i++) {
      assert.ok((ranked[i - 1]?.exclusiveMs ?? 0) >= (ranked[i]?.exclusiveMs ?? 0));
    }
  });
});

describe('narrate', () => {
  test('summarises an analyzed plan with real numbers', () => {
    const text = narratePlan(load('disk-sort.json'));
    assert.match(text, /returned/);
    assert.match(text, /spill/i, 'a plan with a disk spill should mention it');
  });

  test('says plainly when a plan was never executed', () => {
    const text = narratePlan(load('not-analyzed.json'));
    assert.match(text, /not executed|estimate/i);
  });

  test('calls out the worst cardinality error as the thing to fix first', () => {
    const text = narratePlan(load('misestimate.json'));
    assert.match(text, /expected/i);
    assert.match(text, /off by/i);
  });

  test('narrates a node including the loop count', () => {
    const plan = load('seq-scan-filter.json');
    const scan = plan.nodes.find((n) => n.nodeType === 'Seq Scan');
    assert.ok(scan);
    const text = narrateNode(scan, plan);
    assert.match(text, /Reads every row/);
    if ((scan.loops ?? 1) > 1) assert.match(text, /ran .* times/);
  });

  test('explains node types it knows, and degrades gracefully for ones it does not', () => {
    assert.match(explainNodeType('Hash Join').what, /hash table/i);
    // Postgres prefixes qualifiers onto node types; the glossary should see through them.
    assert.equal(explainNodeType('Parallel Seq Scan').what, explainNodeType('Seq Scan').what);
    const unknown = explainNodeType('Some Future Node');
    assert.ok(unknown.what.length > 0);
  });
});

describe('format', () => {
  test('scales time units', () => {
    assert.equal(formatMs(0.5), '0.50 ms');
    assert.equal(formatMs(250), '250.0 ms');
    assert.equal(formatMs(2500), '2.50 s');
    assert.match(formatMs(125_000), /2 m/);
    assert.equal(formatMs(null), '—');
  });

  test('keeps small row counts exact', () => {
    assert.equal(formatRows(1), '1');
    assert.equal(formatRows(999), '999');
    assert.equal(formatRows(12_400), '12.4K');
    assert.equal(formatRows(3_100_000), '3.10M');
  });

  test('suggests a work_mem value a human would type', () => {
    // 3768KB measured → headroom → the next sensible step, not "5.52MB".
    assert.match(suggestWorkMem(3768), /^\d+(MB|GB)$/);
    assert.equal(suggestWorkMem(3768), '8MB');
    assert.equal(suggestWorkMem(100), '4MB');
  });

  test('formats byte sizes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
  });

  describe('percentages never round a partial value to a total one', () => {
    // Regression: a scan reading 400,000 rows and keeping 801 discarded 99.8%.
    // Printing "100% wasted" next to "returned 801 rows" contradicts itself.
    test('99.x% does not become 100%', () => {
      assert.equal(formatPercent(399199 / 400000), '99.7%');
      assert.equal(formatPercent(0.9998), '99.9%');
      assert.equal(formatPercent(0.99999), '99.9%');
    });

    test('a fraction of a percent does not become 0%', () => {
      assert.equal(formatPercent(0.0001), '0.1%');
      assert.equal(formatPercent(0.004), '0.4%');
    });

    test('exact totals still print as totals', () => {
      assert.equal(formatPercent(1), '100%');
      assert.equal(formatPercent(0), '0%');
    });

    test('ordinary values are unaffected', () => {
      assert.equal(formatPercent(0.42), '42%');
      assert.equal(formatPercent(0.9), '90%');
      assert.equal(formatPercent(0.5, 1), '50.0%');
    });
  });
});
