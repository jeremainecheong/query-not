/**
 * Regression tests for parallel-plan time accounting.
 *
 * The bug these exist to prevent: a parallel Seq Scan reported as "202% of
 * runtime". Three workers each spending 13ms is 39ms of work in 13ms of
 * elapsed time, so dividing node time by wall-clock is a category error, not a
 * rounding problem. Every share-of-time figure shown to a user must divide by
 * total work.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseExplainJson } from '../src/parse.ts';
import { analyze } from '../src/analyze.ts';
import { narratePlan, narrateNode } from '../src/narrate.ts';
import type { QueryPlan } from '../src/types.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): QueryPlan =>
  parseExplainJson(readFileSync(join(FIXTURES, name), 'utf8'));

/** Every percentage appearing in a string, as fractions. */
function percentagesIn(text: string): number[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
}

describe('parallel plan accounting', () => {
  test('distinguishes total work from elapsed time', () => {
    const plan = load('seq-scan-filter.json');
    assert.equal(plan.isParallel, true, 'fixture should be a parallel plan');
    assert.ok(plan.totalWorkMs !== null);
    assert.ok(
      (plan.totalWorkMs as number) > (plan.totalMs as number),
      'parallel workers should perform more work than wall-clock elapsed',
    );
  });

  test('a serial plan reports work and elapsed time as roughly equal', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Seq Scan', 'Relation Name': 't', 'Total Cost': 10,
            'Plan Rows': 1, 'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 10,
          },
          'Execution Time': 10.2,
        },
      ]),
    );
    assert.equal(plan.isParallel, false);
    assert.equal(plan.totalWorkMs, 10);
  });

  test('no finding claims a share above 100%', () => {
    for (const name of ['seq-scan-filter.json', 'disk-sort.json', 'nested-loop.json', 'join-agg.json', 'misestimate.json']) {
      for (const finding of analyze(load(name))) {
        for (const pct of [...percentagesIn(finding.title), ...percentagesIn(finding.detail)]) {
          assert.ok(pct <= 100, `${name}: "${finding.title}" reported ${pct}%`);
        }
      }
    }
  });

  test('narration never claims a share above 100%', () => {
    for (const name of ['seq-scan-filter.json', 'disk-sort.json', 'nested-loop.json', 'join-agg.json']) {
      const plan = load(name);
      for (const pct of percentagesIn(narratePlan(plan))) {
        assert.ok(pct <= 100, `${name}: plan narration reported ${pct}%`);
      }
      for (const node of plan.nodes) {
        for (const pct of percentagesIn(narrateNode(node, plan))) {
          assert.ok(pct <= 100, `${name}: ${node.nodeType} narration reported ${pct}%`);
        }
      }
    }
  });

  test('narration explains why work exceeds elapsed time on a parallel plan', () => {
    const text = narratePlan(load('seq-scan-filter.json'));
    assert.match(text, /parallel/i);
    assert.match(text, /elapsed|wall-clock/i);
  });

  test('serial plans do not mention parallelism', () => {
    const plan = parseExplainJson(
      JSON.stringify([
        {
          Plan: {
            'Node Type': 'Seq Scan', 'Relation Name': 't', 'Total Cost': 10,
            'Plan Rows': 100, 'Actual Rows': 100, 'Actual Loops': 1, 'Actual Total Time': 10,
          },
          'Execution Time': 10.2,
        },
      ]),
    );
    assert.equal(/ran in parallel/i.test(narratePlan(plan)), false);
  });
});
