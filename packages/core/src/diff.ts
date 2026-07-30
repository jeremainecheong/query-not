/**
 * Structural plan diffing.
 *
 * This is the load-bearing algorithm. "Add this index" is worthless as advice
 * and valuable as evidence, and the thing that turns one into the other is
 * being able to say precisely what changed between two plans.
 *
 * Approach: align the two trees top-down. Nodes match on a signature
 * (operation + target + relationship), with positional pairing as the
 * tiebreaker when a parent has several children sharing a signature. Anything
 * left unpaired is an addition or a removal.
 *
 * Tree edit distance would be more principled. It is also quadratic and
 * produces alignments that read as arbitrary to a human. Query plans are
 * shallow and their node identity is genuinely carried by the signature, so
 * greedy top-down alignment produces diffs people can follow.
 */

import { describeNode } from './parse.ts';
import { formatMs, formatPercent, formatRows } from './format.ts';
import type { PlanNode, QueryPlan } from './types.ts';

export type DiffStatus = 'unchanged' | 'changed' | 'added' | 'removed';

export interface NodeDiff {
  status: DiffStatus;
  beforeId: string | null;
  afterId: string | null;
  label: string;
  depth: number;
  /** Positive means the after-plan is more expensive. */
  costDelta: number | null;
  timeDelta: number | null;
  rowsDelta: number | null;
  /** Human-readable descriptions of what changed on this node. */
  changes: string[];
}

export type Verdict = 'improved' | 'regressed' | 'unchanged' | 'restructured';

export interface DiffSummary {
  verdict: Verdict;
  /** One sentence, safe to show as the headline result of a what-if. */
  headline: string;
  costBefore: number;
  costAfter: number;
  /** Fractional change in cost. -0.83 means 83% cheaper. */
  costChange: number;
  timeBefore: number | null;
  timeAfter: number | null;
  timeChange: number | null;
  /** Access-method changes, the qualitative signal a what-if is usually after. */
  accessChanges: string[];
  nodesAdded: number;
  nodesRemoved: number;
  /**
   * True when only one side was measured. A cost-only comparison is a claim
   * about the planner's opinion, not about wall-clock time, and the UI must
   * say so rather than implying a speedup was observed.
   */
  costOnly: boolean;
}

export interface PlanDiff {
  nodes: NodeDiff[];
  summary: DiffSummary;
}

/**
 * What makes two nodes "the same node" across plans. Deliberately excludes
 * every measurement — those are what we want to report as changed, not use to
 * decide identity.
 */
function signature(node: PlanNode): string {
  return [
    node.nodeType,
    node.relation ?? node.cteName ?? node.functionName ?? '',
    node.indexName ?? '',
    node.relationship ?? '',
    node.joinType ?? '',
  ].join('|');
}

/** A looser signature, used to pair a node with its own replacement. */
function looseSignature(node: PlanNode): string {
  return [node.relation ?? node.cteName ?? '', node.relationship ?? ''].join('|');
}

interface Pair {
  before: PlanNode | null;
  after: PlanNode | null;
}

/**
 * Pair up two sibling lists. Exact signature matches first, then loose matches
 * on the same relation — which is what catches the case the what-if engine
 * cares about most: a Seq Scan on `orders` becoming an Index Scan on `orders`.
 */
function pairChildren(before: PlanNode[], after: PlanNode[]): Pair[] {
  const pairs: Pair[] = [];
  const remainingBefore = [...before];
  const remainingAfter = [...after];

  const takeMatches = (key: (n: PlanNode) => string) => {
    for (let i = 0; i < remainingBefore.length; i++) {
      const b = remainingBefore[i] as PlanNode;
      const j = remainingAfter.findIndex((a) => key(a) === key(b));
      if (j !== -1) {
        pairs.push({ before: b, after: remainingAfter[j] as PlanNode });
        remainingBefore.splice(i, 1);
        remainingAfter.splice(j, 1);
        i--;
      }
    }
  };

  takeMatches(signature);
  takeMatches(looseSignature);

  // Whatever is left had no counterpart.
  for (const b of remainingBefore) pairs.push({ before: b, after: null });
  for (const a of remainingAfter) pairs.push({ before: null, after: a });

  return pairs;
}

function describeChanges(before: PlanNode, after: PlanNode): string[] {
  const changes: string[] = [];

  if (before.nodeType !== after.nodeType) {
    changes.push(`${before.nodeType} → ${after.nodeType}`);
  }
  if (before.indexName !== after.indexName) {
    if (!before.indexName && after.indexName) {
      changes.push(`now uses index ${after.indexName}`);
    } else if (before.indexName && !after.indexName) {
      changes.push(`no longer uses index ${before.indexName}`);
    } else {
      changes.push(`index ${before.indexName} → ${after.indexName}`);
    }
  }
  if (before.joinType !== after.joinType && after.joinType) {
    changes.push(`join type ${before.joinType ?? 'none'} → ${after.joinType}`);
  }

  const costChange = relativeChange(before.totalCost, after.totalCost);
  if (costChange !== null && Math.abs(costChange) >= 0.05) {
    changes.push(
      `cost ${before.totalCost.toFixed(0)} → ${after.totalCost.toFixed(0)} (${signedPercent(costChange)})`,
    );
  }

  if (before.inclusiveMs !== null && after.inclusiveMs !== null) {
    const timeChange = relativeChange(before.inclusiveMs, after.inclusiveMs);
    if (timeChange !== null && Math.abs(timeChange) >= 0.1) {
      changes.push(
        `time ${formatMs(before.inclusiveMs)} → ${formatMs(after.inclusiveMs)} (${signedPercent(timeChange)})`,
      );
    }
  }

  if (
    before.actualRowsTotal !== null &&
    after.actualRowsTotal !== null &&
    before.actualRowsTotal !== after.actualRowsTotal
  ) {
    changes.push(
      `rows ${formatRows(before.actualRowsTotal)} → ${formatRows(after.actualRowsTotal)}`,
    );
  }

  // Spill state is a step change, not a gradient — always worth calling out.
  const beforeSpilled = before.sortSpaceType === 'Disk';
  const afterSpilled = after.sortSpaceType === 'Disk';
  if (beforeSpilled && !afterSpilled) changes.push('sort no longer spills to disk');
  if (!beforeSpilled && afterSpilled) changes.push('sort now spills to disk');

  const beforeBatches = before.hashBatches ?? 1;
  const afterBatches = after.hashBatches ?? 1;
  if (beforeBatches > 1 && afterBatches === 1) changes.push('hash now fits in one batch');
  if (beforeBatches === 1 && afterBatches > 1) changes.push(`hash now spills to ${afterBatches} batches`);

  return changes;
}

function relativeChange(before: number, after: number): number | null {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  if (before === 0) return after === 0 ? 0 : null;
  return (after - before) / before;
}

function signedPercent(fraction: number): string {
  const sign = fraction > 0 ? '+' : '';
  return `${sign}${formatPercent(fraction)}`;
}

export function diffPlans(before: QueryPlan, after: QueryPlan): PlanDiff {
  const nodes: NodeDiff[] = [];

  const walk = (pair: Pair, depth: number): void => {
    const { before: b, after: a } = pair;

    if (b && a) {
      const changes = describeChanges(b, a);
      nodes.push({
        status: changes.length > 0 ? 'changed' : 'unchanged',
        beforeId: b.id,
        afterId: a.id,
        label: describeNode(a),
        depth,
        costDelta: a.totalCost - b.totalCost,
        timeDelta:
          b.inclusiveMs !== null && a.inclusiveMs !== null ? a.inclusiveMs - b.inclusiveMs : null,
        rowsDelta:
          b.actualRowsTotal !== null && a.actualRowsTotal !== null
            ? a.actualRowsTotal - b.actualRowsTotal
            : null,
        changes,
      });
      for (const child of pairChildren(b.children, a.children)) walk(child, depth + 1);
      return;
    }

    if (a) {
      nodes.push({
        status: 'added',
        beforeId: null,
        afterId: a.id,
        label: describeNode(a),
        depth,
        costDelta: a.totalCost,
        timeDelta: a.inclusiveMs,
        rowsDelta: a.actualRowsTotal,
        changes: ['node added'],
      });
      for (const child of a.children) walk({ before: null, after: child }, depth + 1);
      return;
    }

    if (b) {
      nodes.push({
        status: 'removed',
        beforeId: b.id,
        afterId: null,
        label: describeNode(b),
        depth,
        costDelta: -b.totalCost,
        timeDelta: b.inclusiveMs === null ? null : -b.inclusiveMs,
        rowsDelta: b.actualRowsTotal === null ? null : -b.actualRowsTotal,
        changes: ['node removed'],
      });
      for (const child of b.children) walk({ before: child, after: null }, depth + 1);
    }
  };

  walk({ before: before.root, after: after.root }, 0);

  return { nodes, summary: summarise(before, after, nodes) };
}

function summarise(before: QueryPlan, after: QueryPlan, nodes: NodeDiff[]): DiffSummary {
  const costBefore = before.totalCost;
  const costAfter = after.totalCost;
  const costChange = relativeChange(costBefore, costAfter) ?? 0;

  const timeBefore = before.totalMs;
  const timeAfter = after.totalMs;
  const bothTimed = timeBefore !== null && timeAfter !== null && before.analyzed && after.analyzed;
  const timeChange = bothTimed ? relativeChange(timeBefore, timeAfter) : null;

  // Access-method changes are the qualitative result: this is what "the index
  // worked" actually looks like in a plan.
  const accessChanges: string[] = [];
  for (const n of nodes) {
    for (const c of n.changes) {
      if (
        c.includes('→') &&
        (c.includes('Scan') || c.includes('Join') || c.startsWith('now uses index'))
      ) {
        accessChanges.push(`${n.label}: ${c}`);
      } else if (c.startsWith('now uses index') || c.startsWith('no longer uses index')) {
        accessChanges.push(`${n.label}: ${c}`);
      }
    }
  }

  const nodesAdded = nodes.filter((n) => n.status === 'added').length;
  const nodesRemoved = nodes.filter((n) => n.status === 'removed').length;

  // Prefer measured time when we have it on both sides; fall back to the
  // planner's cost, and label that fallback honestly.
  const primary = timeChange ?? costChange;
  const threshold = 0.05;

  let verdict: Verdict;
  if (Math.abs(primary) < threshold) {
    verdict = nodesAdded + nodesRemoved > 0 || accessChanges.length > 0 ? 'restructured' : 'unchanged';
  } else {
    verdict = primary < 0 ? 'improved' : 'regressed';
  }

  const costOnly = !bothTimed;
  const metric = costOnly ? 'estimated cost' : 'runtime';
  const magnitude = formatPercent(Math.abs(primary));

  let headline: string;
  switch (verdict) {
    case 'improved':
      headline =
        `${metric === 'runtime' ? 'Runtime' : 'Estimated cost'} fell by ${magnitude}` +
        (accessChanges.length > 0 ? ` — ${accessChanges[0]}` : '') +
        (costOnly ? '. This is the planner’s estimate, not a measured speedup.' : '.');
      break;
    case 'regressed':
      headline =
        `${metric === 'runtime' ? 'Runtime' : 'Estimated cost'} rose by ${magnitude}` +
        (costOnly ? '. This is the planner’s estimate, not a measured slowdown.' : '.');
      break;
    case 'restructured':
      headline =
        `The plan changed shape but ${metric} is essentially the same` +
        (accessChanges.length > 0 ? ` — ${accessChanges[0]}` : '') +
        '.';
      break;
    default:
      headline = `No change — the planner produced the same plan, at the same ${metric}.`;
  }

  return {
    verdict,
    headline,
    costBefore,
    costAfter,
    costChange,
    timeBefore,
    timeAfter,
    timeChange,
    accessChanges,
    nodesAdded,
    nodesRemoved,
    costOnly,
  };
}
