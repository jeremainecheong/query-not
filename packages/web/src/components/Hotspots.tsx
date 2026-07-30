/**
 * Operations ranked by self time.
 *
 * The graph shows structure and row flow; this shows magnitude, sorted. It
 * exists because an icicle chart is a bad answer to "which operation is
 * slowest" — in a deep plan every ancestor spans the full width, so five
 * different nodes all render as full-width bars and the picture reads as
 * "everything is equal" when it is not.
 *
 * A sorted bar list has no such ambiguity: longest bar, biggest problem.
 */

import { describeNode, formatMs, formatPercent, type PlanNode, type QueryPlan } from '@query-not/core';

const MAX_ROWS = 8;

export function Hotspots({
  plan,
  selectedId,
  onSelect,
}: {
  plan: QueryPlan;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const totalWork = plan.totalWorkMs ?? plan.totalMs ?? 0;

  const ranked = [...plan.nodes]
    .filter((n) => !n.neverExecuted)
    .sort((a, b) => selfOf(b, plan) - selfOf(a, plan))
    .slice(0, MAX_ROWS);

  const top = selfOf(ranked[0] as PlanNode, plan);
  if (top <= 0) {
    return (
      <div className="empty">
        <p>
          {plan.analyzed
            ? 'Every operation finished too quickly to rank meaningfully.'
            : 'Run with “Execute to measure” to see where time is actually spent.'}
        </p>
      </div>
    );
  }

  return (
    <div className="ranked">
      {ranked.map((node, i) => {
        const self = selfOf(node, plan);
        const share = totalWork > 0 ? self / totalWork : 0;
        const isTop = i === 0;

        return (
          <button
            key={node.id}
            className={`ranked__row${node.id === selectedId ? ' ranked__row--selected' : ''}`}
            onClick={() => onSelect(node.id)}
          >
            <span className="ranked__label">
              <span className="ranked__op">{node.nodeType}</span>
              {node.relation && <span className="ranked__rel">{node.relation}</span>}
            </span>

            <span className="ranked__track" aria-hidden="true">
              <span
                className="ranked__fill"
                style={{
                  width: `${Math.max((self / top) * 100, 2)}%`,
                  background: isTop ? 'var(--status-critical)' : 'var(--accent)',
                }}
              />
            </span>

            <span className="ranked__value">
              {plan.analyzed ? formatMs(self) : self.toFixed(0)}
            </span>
            <span className="ranked__share">{formatPercent(share)}</span>
          </button>
        );
      })}

      <p className="ranked__note">
        {plan.analyzed
          ? `Self time — work done in each operation itself, excluding its children. Shares are of ${formatMs(totalWork)} total work.`
          : 'Estimated self cost. Run with “Execute to measure” for real timings.'}
      </p>
    </div>
  );
}

/** Self time when measured, self cost otherwise, so the view still ranks. */
function selfOf(node: PlanNode | undefined, plan: QueryPlan): number {
  if (!node) return 0;
  if (plan.analyzed) return node.exclusiveMs ?? 0;
  let childCost = 0;
  for (const child of node.children) childCost += child.totalCost;
  return Math.max(node.totalCost - childCost, 0);
}

/** Screen-reader / no-chart fallback naming the top operation in words. */
export function hotspotSummary(plan: QueryPlan): string {
  const ranked = [...plan.nodes]
    .filter((n) => !n.neverExecuted)
    .sort((a, b) => selfOf(b, plan) - selfOf(a, plan));
  const top = ranked[0];
  if (!top) return 'No operations to rank.';
  const totalWork = plan.totalWorkMs ?? plan.totalMs ?? 0;
  const self = selfOf(top, plan);
  return `${describeNode(top)} is the slowest operation at ${formatMs(self)}${
    totalWork > 0 ? `, ${formatPercent(self / totalWork)} of total work` : ''
  }.`;
}
