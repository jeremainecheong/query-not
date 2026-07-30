/**
 * Flame graph layout.
 *
 * Lives in core rather than the UI because the interesting decision here is
 * analytical, not visual: the bars are weighted by **exclusive** time, so the
 * width of a node is the time spent in that node itself. A tree weighted by
 * inclusive time just draws the root at 100% and tells you nothing.
 *
 * Falls back to cost when the plan was not executed, so an un-analyzed plan
 * still renders something meaningful — clearly labelled as estimate-based.
 */

import { describeNode } from './parse.ts';
import type { PlanNode, QueryPlan } from './types.ts';

export interface FlameCell {
  nodeId: string;
  label: string;
  nodeType: string;
  depth: number;
  /** Fraction of the total, 0..1, where the bar starts. */
  x: number;
  /** Fraction of the total, 0..1. */
  width: number;
  /** The weight this cell was sized by. */
  value: number;
  /** Self value — what this node contributed, excluding children. */
  selfValue: number;
  misestimate: number | null;
  neverExecuted: boolean;
}

export interface FlameLayout {
  cells: FlameCell[];
  maxDepth: number;
  total: number;
  /** 'time' when built from measured exclusive time, 'cost' when estimated. */
  basis: 'time' | 'cost';
}

/**
 * The weight of a whole subtree: this node's own contribution plus its
 * children's. Computed rather than read off `inclusiveMs`, so the parent's
 * width always equals the sum of its children plus its own self time. Without
 * that invariant the bars don't line up and the picture lies.
 */
function subtreeWeight(node: PlanNode, basis: 'time' | 'cost'): number {
  const self = selfWeight(node, basis);
  let sum = self;
  for (const child of node.children) sum += subtreeWeight(child, basis);
  return sum;
}

function selfWeight(node: PlanNode, basis: 'time' | 'cost'): number {
  if (node.neverExecuted) return 0;
  if (basis === 'time') return Math.max(node.exclusiveMs ?? 0, 0);
  // Cost basis: the node's own cost, excluding what its children already account for.
  let childCost = 0;
  for (const child of node.children) childCost += child.totalCost;
  return Math.max(node.totalCost - childCost, 0);
}

export function layoutFlame(plan: QueryPlan): FlameLayout {
  const basis: 'time' | 'cost' = plan.analyzed && plan.root.inclusiveMs !== null ? 'time' : 'cost';
  const total = subtreeWeight(plan.root, basis);
  const cells: FlameCell[] = [];
  let maxDepth = 0;

  const place = (node: PlanNode, x: number, depth: number): void => {
    const weight = subtreeWeight(node, basis);
    const width = total > 0 ? weight / total : 0;
    maxDepth = Math.max(maxDepth, depth);

    cells.push({
      nodeId: node.id,
      label: describeNode(node),
      nodeType: node.nodeType,
      depth,
      x,
      width,
      value: weight,
      selfValue: selfWeight(node, basis),
      misestimate: node.misestimate,
      neverExecuted: node.neverExecuted,
    });

    // Children are laid out left to right inside the parent's span. The
    // remainder — the parent's own self time — is the gap that stays visible
    // beneath it, which is exactly the signal we want readable.
    let cursor = x;
    for (const child of node.children) {
      const childWidth = total > 0 ? subtreeWeight(child, basis) / total : 0;
      place(child, cursor, depth + 1);
      cursor += childWidth;
    }
  };

  place(plan.root, 0, 0);

  return { cells, maxDepth, total, basis };
}

/**
 * Nodes ranked by self time. The list that answers "where did the time go"
 * without needing to read a tree at all.
 */
export function hotspots(plan: QueryPlan, limit = 5): PlanNode[] {
  return [...plan.nodes]
    .filter((n) => !n.neverExecuted)
    .sort((a, b) => (b.exclusiveMs ?? 0) - (a.exclusiveMs ?? 0))
    .slice(0, limit);
}
