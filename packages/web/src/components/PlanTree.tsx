/**
 * The plan tree.
 *
 * Leads with totals, never per-loop figures — the whole point of the IR's
 * loops handling. A node showing "0.03 ms" that ran 90,000 times is the single
 * most misread number in a Postgres plan, so it is never shown alone.
 */

import { describeNode, formatMs, formatRatio, formatRows, type PlanNode, type QueryPlan } from '@query-not/core';

interface Props {
  plan: QueryPlan;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}

export function PlanTree({ plan, selectedId, onSelect }: Props) {
  const maxSelf = Math.max(...plan.nodes.map((n) => n.exclusiveMs ?? 0), 1);

  return (
    <div className="tree">
      {plan.nodes.map((node) => (
        <Row
          key={node.id}
          node={node}
          plan={plan}
          maxSelf={maxSelf}
          selected={node.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function Row({
  node,
  plan,
  maxSelf,
  selected,
  onSelect,
}: {
  node: PlanNode;
  plan: QueryPlan;
  maxSelf: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const selfShare = (node.exclusiveMs ?? 0) / maxSelf;
  const spilled = node.sortSpaceType === 'Disk' || (node.hashBatches ?? 1) > 1;

  return (
    <div
      className={`tree__row${selected ? ' tree__row--selected' : ''}`}
      style={{ paddingLeft: `calc(var(--sp-5) + ${node.depth * 16}px)` }}
      onClick={() => onSelect(node.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <div className="tree__label">
        <span className="tree__name">
          {node.nodeType}
          {node.relation && <span className="tree__rel"> on {node.relation}</span>}
          {node.indexName && <span className="tree__rel"> · {node.indexName}</span>}
        </span>
        {node.neverExecuted && <span className="pill">never executed</span>}
        {spilled && (
          <span className="pill">
            <span className="dot dot--critical" aria-hidden="true" />
            spilled to disk
          </span>
        )}
      </div>

      <div className="tree__metrics">
        {plan.analyzed && !node.neverExecuted && (
          <>
            {node.misestimate !== null && node.misestimate >= 10 && (
              <span className="chip" title={`Estimated ${formatRows(node.estimatedRowsTotal)}, actual ${formatRows(node.actualRowsTotal)}`}>
                <b>{formatRatio(node.misestimate)}</b> {node.misestimateDirection === 'over' ? 'high' : 'low'}
              </span>
            )}
            {node.loops !== null && node.loops > 1 && (
              <span className="chip" title="This node ran more than once; the times shown are totals, not per-loop">
                ×<b>{formatRows(node.loops)}</b>
              </span>
            )}
            <span className="chip" title="Rows returned in total">
              <b>{formatRows(node.actualRowsTotal)}</b> rows
            </span>
            <span className="chip" title="Time in this node itself, excluding children">
              <b>{formatMs(node.exclusiveMs)}</b> self
            </span>
            <span className="tree__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(selfShare * 100, selfShare > 0 ? 3 : 0)}%` }} />
            </span>
          </>
        )}
        {!plan.analyzed && (
          <>
            <span className="chip">
              <b>{formatRows(node.estimatedRowsTotal)}</b> est. rows
            </span>
            <span className="chip">
              cost <b>{node.totalCost.toFixed(0)}</b>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** Detail for one selected node — the numbers that did not fit in the row. */
export function NodeDetail({ node, plan }: { node: PlanNode; plan: QueryPlan }) {
  const rows: Array<[string, string]> = [];

  rows.push(['Operation', describeNode(node)]);
  if (plan.analyzed && !node.neverExecuted) {
    rows.push(['Rows returned', formatRows(node.actualRowsTotal)]);
    rows.push(['Rows estimated', formatRows(node.estimatedRowsTotal)]);
    if (node.misestimate !== null && node.misestimate > 1) {
      rows.push([
        'Estimate error',
        `${formatRatio(node.misestimate)} too ${node.misestimateDirection === 'over' ? 'high' : 'low'}`,
      ]);
    }
    if (node.loops !== null && node.loops > 1) {
      rows.push(['Loops', `${formatRows(node.loops)} × ${formatMs(node.actualTotalTime)} each`]);
    }
    rows.push(['Time (subtree)', formatMs(node.inclusiveMs)]);
    rows.push(['Time (self)', formatMs(node.exclusiveMs)]);
  }
  rows.push(['Cost', `${node.startupCost.toFixed(0)} … ${node.totalCost.toFixed(0)}`]);

  if (node.rowsRemovedByFilter) {
    rows.push(['Rows discarded by filter', formatRows(node.rowsRemovedByFilter * (node.loops ?? 1))]);
  }
  if (node.sortMethod) {
    rows.push(['Sort method', `${node.sortMethod}${node.sortSpaceType ? ` (${node.sortSpaceType})` : ''}`]);
  }
  if (node.hashBatches !== null && node.hashBatches > 1) {
    rows.push(['Hash batches', String(node.hashBatches)]);
  }
  if (node.workersLaunched !== null) {
    rows.push(['Parallel workers', `${node.workersLaunched} launched of ${node.workersPlanned ?? '?'} planned`]);
  }
  if (node.exclusiveBuffers) {
    const b = node.exclusiveBuffers;
    rows.push(['Buffers (self)', `${formatRows(b.sharedHit)} hit, ${formatRows(b.sharedRead)} read`]);
  }

  const predicates: Array<[string, string]> = [];
  if (node.indexCond) predicates.push(['Index condition', node.indexCond]);
  if (node.filter) predicates.push(['Filter', node.filter]);
  if (node.joinFilter) predicates.push(['Join filter', node.joinFilter]);
  if (node.hashCond) predicates.push(['Hash condition', node.hashCond]);
  if (node.recheckCond) predicates.push(['Recheck condition', node.recheckCond]);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px var(--sp-5)', fontSize: 13 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <div style={{ color: 'var(--ink-muted)' }}>{k}</div>
            <div style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</div>
          </div>
        ))}
      </div>

      {predicates.length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          {predicates.map(([k, v]) => (
            <div key={k}>
              <div style={{ color: 'var(--ink-muted)', fontSize: 12, marginBottom: 3 }}>{k}</div>
              <div className="code">{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
