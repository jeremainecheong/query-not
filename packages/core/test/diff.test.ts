import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExplainJson } from '../src/parse.ts';
import { diffPlans } from '../src/diff.ts';
import type { QueryPlan } from '../src/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): QueryPlan {
  return parseExplainJson(readFileSync(join(FIXTURES, name), 'utf8'));
}

describe('diffPlans', () => {
  describe('a real hypothetical-index what-if', () => {
    // These fixtures are genuine EXPLAIN output captured either side of a
    // HypoPG hypothetical index — the exact loop the what-if engine runs.
    const before = () => loadFixture('whatif-before.json');
    const after = () => loadFixture('whatif-after.json');

    test('recognises the improvement', () => {
      const { summary } = diffPlans(before(), after());
      assert.equal(summary.verdict, 'improved');
      assert.ok(summary.costAfter < summary.costBefore);
      assert.ok(summary.costChange < -0.5, `expected a large cost drop, got ${summary.costChange}`);
    });

    test('reports the access-method change, which is the actual evidence', () => {
      const { summary } = diffPlans(before(), after());
      assert.ok(
        summary.accessChanges.length > 0,
        'a Seq Scan becoming an Index Scan must surface as an access change',
      );
      assert.match(summary.accessChanges.join(' '), /Scan|index/i);
    });

    test('labels a cost-only comparison honestly', () => {
      // HypoPG cannot be used with EXPLAIN ANALYZE — the index does not exist,
      // so there is nothing to execute against. The result is a claim about the
      // planner's opinion, and the headline must not imply a measured speedup.
      const { summary } = diffPlans(before(), after());
      assert.equal(summary.costOnly, true);
      assert.match(summary.headline, /estimated cost/i);
      // Must actively disclaim measurement, not merely omit the claim.
      assert.match(summary.headline, /not a measured speedup/i);
      assert.equal(summary.timeBefore, null);
      assert.equal(summary.timeAfter, null);
    });

    test('notices the removed Gather node', () => {
      const { summary, nodes } = diffPlans(before(), after());
      assert.ok(summary.nodesRemoved > 0 || nodes.some((n) => n.status === 'removed'));
    });
  });

  describe('identity', () => {
    test('a plan against itself is unchanged', () => {
      const { summary, nodes } = diffPlans(loadFixture('join-agg.json'), loadFixture('join-agg.json'));
      assert.equal(summary.verdict, 'unchanged');
      assert.equal(summary.nodesAdded, 0);
      assert.equal(summary.nodesRemoved, 0);
      assert.equal(nodes.every((n) => n.status === 'unchanged'), true);
      assert.equal(summary.costChange, 0);
    });
  });

  describe('regression detection', () => {
    test('reports a cost increase as a regression', () => {
      const cheap = parseExplainJson(
        JSON.stringify([
          { Plan: { 'Node Type': 'Index Scan', 'Relation Name': 't', 'Index Name': 'i', 'Total Cost': 10, 'Plan Rows': 5 } },
        ]),
      );
      const expensive = parseExplainJson(
        JSON.stringify([
          { Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 't', 'Total Cost': 500, 'Plan Rows': 5 } },
        ]),
      );
      const { summary } = diffPlans(cheap, expensive);
      assert.equal(summary.verdict, 'regressed');
      assert.match(summary.headline, /rose/);
      assert.ok(summary.accessChanges.some((c) => /Index Scan → Seq Scan/.test(c)));
    });
  });

  describe('alignment', () => {
    test('pairs a node with its replacement on the same relation', () => {
      // Seq Scan on orders → Index Scan on orders is one changed node, not one
      // added plus one removed. Getting this wrong makes every diff unreadable.
      const before = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Aggregate', 'Total Cost': 100, 'Plan Rows': 1,
              Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Parent Relationship': 'Outer', 'Total Cost': 90, 'Plan Rows': 100 }],
            },
          },
        ]),
      );
      const after = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Aggregate', 'Total Cost': 20, 'Plan Rows': 1,
              Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'orders', 'Index Name': 'orders_status_idx', 'Parent Relationship': 'Outer', 'Total Cost': 15, 'Plan Rows': 100 }],
            },
          },
        ]),
      );
      const { nodes } = diffPlans(before, after);
      assert.equal(nodes.filter((n) => n.status === 'added').length, 0);
      assert.equal(nodes.filter((n) => n.status === 'removed').length, 0);

      const scan = nodes.find((n) => n.label.includes('orders'));
      assert.ok(scan);
      assert.equal(scan.status, 'changed');
      assert.ok(scan.changes.some((c) => c.includes('Seq Scan → Index Scan')));
      assert.ok(scan.changes.some((c) => c.includes('now uses index orders_status_idx')));
    });

    test('does not pair unrelated siblings', () => {
      const before = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Hash Join', 'Total Cost': 100, 'Plan Rows': 1,
              Plans: [
                { 'Node Type': 'Seq Scan', 'Relation Name': 'a', 'Parent Relationship': 'Outer', 'Total Cost': 10, 'Plan Rows': 1 },
                { 'Node Type': 'Seq Scan', 'Relation Name': 'b', 'Parent Relationship': 'Inner', 'Total Cost': 10, 'Plan Rows': 1 },
              ],
            },
          },
        ]),
      );
      const after = parseExplainJson(
        JSON.stringify([
          {
            Plan: {
              'Node Type': 'Hash Join', 'Total Cost': 100, 'Plan Rows': 1,
              Plans: [
                { 'Node Type': 'Seq Scan', 'Relation Name': 'a', 'Parent Relationship': 'Outer', 'Total Cost': 10, 'Plan Rows': 1 },
                { 'Node Type': 'Seq Scan', 'Relation Name': 'c', 'Parent Relationship': 'Inner', 'Total Cost': 10, 'Plan Rows': 1 },
              ],
            },
          },
        ]),
      );
      const { nodes } = diffPlans(before, after);
      assert.equal(nodes.some((n) => n.status === 'removed' && n.label.includes('b')), true);
      assert.equal(nodes.some((n) => n.status === 'added' && n.label.includes('c')), true);
    });
  });

  describe('spill transitions', () => {
    test('calls out a sort that stops spilling', () => {
      const spilling = parseExplainJson(
        JSON.stringify([
          { Plan: { 'Node Type': 'Sort', 'Total Cost': 100, 'Plan Rows': 1000, 'Sort Space Type': 'Disk', 'Sort Method': 'external merge' } },
        ]),
      );
      const inMemory = parseExplainJson(
        JSON.stringify([
          { Plan: { 'Node Type': 'Sort', 'Total Cost': 60, 'Plan Rows': 1000, 'Sort Space Type': 'Memory', 'Sort Method': 'quicksort' } },
        ]),
      );
      const { nodes } = diffPlans(spilling, inMemory);
      assert.ok(nodes[0]?.changes.includes('sort no longer spills to disk'));
    });
  });
});
