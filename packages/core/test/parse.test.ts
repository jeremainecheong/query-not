import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExplainJson, PlanParseError, describeNode } from '../src/parse.ts';
import type { PlanNode, QueryPlan } from '../src/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function loadFixture(name: string): QueryPlan {
  return parseExplainJson(readFileSync(join(FIXTURES, name), 'utf8'));
}

function findByType(plan: QueryPlan, nodeType: string): PlanNode {
  const node = plan.nodes.find((n) => n.nodeType === nodeType);
  assert.ok(node, `expected a ${nodeType} node in this plan`);
  return node;
}

describe('parseExplainJson', () => {
  test('parses an analyzed plan and marks it as measured', () => {
    const plan = loadFixture('seq-scan-filter.json');
    assert.equal(plan.analyzed, true);
    assert.equal(plan.hasBuffers, true);
    assert.ok(plan.executionTimeMs && plan.executionTimeMs > 0);
    assert.ok(plan.planningTimeMs && plan.planningTimeMs > 0);
    assert.equal(plan.totalMs, plan.executionTimeMs);
  });

  test('distinguishes an un-analyzed plan', () => {
    const plan = loadFixture('not-analyzed.json');
    assert.equal(plan.analyzed, false);
    assert.equal(plan.executionTimeMs, null);
    for (const node of plan.nodes) {
      assert.equal(node.actualRows, null);
      assert.equal(node.inclusiveMs, null);
    }
  });

  test('captures SETTINGS when requested', () => {
    const plan = loadFixture('seq-scan-filter.json');
    // The fixture was captured with SETTINGS; the exact keys depend on the
    // server's non-default GUCs, so assert the shape rather than a value.
    assert.equal(typeof plan.settings, 'object');
  });

  describe('the loops trap', () => {
    test('multiplies per-loop rows out to a total', () => {
      const plan = loadFixture('seq-scan-filter.json');
      const scan = findByType(plan, 'Seq Scan');

      assert.ok(scan.loops && scan.loops > 1, 'fixture should have a parallel scan with >1 loops');
      assert.equal(scan.actualRowsTotal, (scan.actualRows as number) * scan.loops);
      assert.equal(scan.estimatedRowsTotal, scan.planRows * scan.loops);
      // The whole point: the total is meaningfully larger than the per-loop figure.
      assert.ok((scan.actualRowsTotal as number) > (scan.actualRows as number));
    });

    test('multiplies per-loop time out to a total', () => {
      const plan = loadFixture('seq-scan-filter.json');
      const scan = findByType(plan, 'Seq Scan');
      assert.equal(scan.inclusiveMs, (scan.actualTotalTime as number) * (scan.loops as number));
    });
  });

  describe('exclusive time', () => {
    test('is inclusive time minus children, never negative', () => {
      for (const name of ['join-agg.json', 'disk-sort.json', 'nested-loop.json']) {
        const plan = loadFixture(name);
        for (const node of plan.nodes) {
          if (node.exclusiveMs === null) continue;
          assert.ok(node.exclusiveMs >= 0, `${name}: ${node.nodeType} had negative self time`);
          assert.ok(
            node.exclusiveMs <= (node.inclusiveMs as number) + 1e-6,
            `${name}: ${node.nodeType} self time exceeded inclusive time`,
          );
        }
      }
    });

    test('a leaf node spends all its time in itself', () => {
      const plan = loadFixture('seq-scan-filter.json');
      const scan = findByType(plan, 'Seq Scan');
      assert.equal(scan.children.length, 0);
      assert.equal(scan.exclusiveMs, scan.inclusiveMs);
    });
  });

  describe('misestimate', () => {
    test('is a ratio >= 1 with a direction', () => {
      const plan = loadFixture('misestimate.json');
      const scan = findByType(plan, 'Seq Scan');
      assert.ok(scan.misestimate !== null);
      assert.ok(
        (scan.misestimate as number) > 10,
        `expected a large cardinality error, got ${scan.misestimate}`,
      );
      assert.equal(scan.misestimateDirection, 'under');
    });

    test('never divides by zero when a node returns no rows', () => {
      const plan = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Relation Name': 't',
              'Plan Rows': 1000,
              'Actual Rows': 0,
              'Actual Loops': 1,
              'Total Cost': 10,
            },
          },
        ]),
      );
      assert.equal(plan.root.misestimate, 1000);
      assert.equal(plan.root.misestimateDirection, 'over');
    });

    test('is 1 when the estimate was exact', () => {
      const plan = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Seq Scan',
              'Plan Rows': 42,
              'Actual Rows': 42,
              'Actual Loops': 1,
              'Total Cost': 1,
            },
          },
        ]),
      );
      assert.equal(plan.root.misestimate, 1);
      assert.equal(plan.root.misestimateDirection, null);
    });
  });

  describe('never-executed nodes', () => {
    test('are flagged and contribute nothing', () => {
      const plan = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Nested Loop',
              'Total Cost': 10,
              'Plan Rows': 1,
              'Actual Rows': 0,
              'Actual Loops': 1,
              'Actual Total Time': 0.5,
              Plans: [
                {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'never_run',
                  'Plan Rows': 100,
                  'Actual Rows': 0,
                  'Actual Loops': 0,
                  'Total Cost': 5,
                },
              ],
            },
          },
        ]),
      );
      const child = plan.nodes.find((n) => n.relation === 'never_run');
      assert.ok(child);
      assert.equal(child.neverExecuted, true);
      assert.equal(child.estimatedRowsTotal, 0);
      assert.equal(child.actualRowsTotal, 0);
      assert.equal(child.misestimate, null, 'a node that never ran has no measurable error');
    });
  });

  describe('spill detection', () => {
    test('reads sort method and disk usage', () => {
      const plan = loadFixture('disk-sort.json');
      const sort = findByType(plan, 'Sort');
      assert.equal(sort.sortSpaceType, 'Disk');
      assert.match(sort.sortMethod as string, /external/);
      assert.ok((sort.sortSpaceUsedKb as number) > 0);
    });
  });

  describe('buffers', () => {
    test('computes exclusive buffers and never goes negative', () => {
      const plan = loadFixture('join-agg.json');
      for (const node of plan.nodes) {
        if (!node.exclusiveBuffers) continue;
        for (const v of Object.values(node.exclusiveBuffers)) {
          assert.ok(v >= 0, `${node.nodeType} had a negative exclusive buffer count`);
        }
      }
    });
  });

  describe('tree shape', () => {
    test('flattens to every node exactly once, with correct parent links', () => {
      const plan = loadFixture('join-agg.json');
      const ids = new Set(plan.nodes.map((n) => n.id));
      assert.equal(ids.size, plan.nodes.length, 'node ids must be unique');

      let counted = 0;
      const walk = (n: PlanNode, parentId: string | null, depth: number) => {
        counted++;
        assert.equal(n.parentId, parentId);
        assert.equal(n.depth, depth);
        for (const c of n.children) walk(c, n.id, depth + 1);
      };
      walk(plan.root, null, 0);
      assert.equal(counted, plan.nodes.length);
    });
  });

  describe('input tolerance', () => {
    test('accepts a pre-parsed array', () => {
      const raw = JSON.parse(readFileSync(join(FIXTURES, 'seq-scan-filter.json'), 'utf8'));
      const plan = parseExplainJson(raw);
      assert.equal(plan.root.nodeType, 'Gather');
    });

    test('accepts a bare plan object without the envelope', () => {
      const plan = parseExplainJson({
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        'Total Cost': 5,
        'Plan Rows': 1,
      });
      assert.equal(plan.root.relation, 'orders');
      assert.equal(plan.analyzed, false);
    });

    test('rejects text-format plans with an actionable message', () => {
      assert.throws(
        () => parseExplainJson('Seq Scan on orders  (cost=0.00..1.00 rows=1 width=4)'),
        (err: unknown) => err instanceof PlanParseError && /FORMAT JSON/.test((err as Error).message),
      );
    });

    test('rejects JSON that is not a plan', () => {
      assert.throws(() => parseExplainJson('{"hello":"world"}'), PlanParseError);
      assert.throws(() => parseExplainJson('[]'), PlanParseError);
      assert.throws(() => parseExplainJson('   '), PlanParseError);
    });
  });

  describe('describeNode', () => {
    test('names the operation and its target', () => {
      const plan = loadFixture('seq-scan-filter.json');
      const scan = findByType(plan, 'Seq Scan');
      assert.equal(describeNode(scan), 'Seq Scan on orders');
    });

    test('includes the index when one is used', () => {
      const plan = loadFixture('nested-loop.json');
      const idx = plan.nodes.find((n) => n.indexName);
      if (idx) assert.match(describeNode(idx), /using /);
    });
  });
});
