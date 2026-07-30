/**
 * The plan as a graph.
 *
 * A flame graph answers "how is time distributed" but hides the thing that
 * actually explains a slow query: **row flow**. The reason a scan is expensive
 * is usually that 400,000 rows went in and 801 came out, and that fact is
 * invisible in a bar chart.
 *
 * So this draws the plan as a node-link diagram with two simultaneous encodings:
 *
 *   edge thickness  = rows flowing between operations (sqrt-scaled)
 *   node time bar   = share of total work spent in that operation itself
 *
 * Read together they answer "where did the time go" and "why" in one glance:
 * a fat edge narrowing to a thin one is wasted reads; a full time bar is the
 * hotspot. The hotspot is called out explicitly rather than left to inference.
 *
 * Layout runs bottom-up — leaves at the bottom, result at the top — because
 * that is the direction rows actually travel through a plan.
 */

import { useMemo, useState } from 'react';
import {
  describeNode,
  formatMs,
  formatPercent,
  formatRatio,
  formatRows,
  type PlanNode,
  type QueryPlan,
} from '@query-not/core';

const CARD_W = 178;
const CARD_H = 68;
const COL_GAP = 24;
const ROW_GAP = 40;
const PAD = 20;

/** Edge widths span a huge dynamic range, so scale by square root. */
function edgeWidth(rows: number, maxRows: number): number {
  if (maxRows <= 0 || rows <= 0) return 1.5;
  return 1.5 + Math.sqrt(rows / maxRows) * 15;
}

type Severity = 'none' | 'low' | 'mid' | 'high';

function severityOf(node: PlanNode, analyzed: boolean): Severity {
  if (!analyzed || node.misestimate === null || node.neverExecuted) return 'none';
  if (node.misestimate >= 100) return 'high';
  if (node.misestimate >= 10) return 'mid';
  return 'low';
}

interface Placed {
  node: PlanNode;
  x: number;
  y: number;
  /** Rows leaving this node, i.e. flowing into its parent. */
  rowsOut: number;
  selfShare: number;
  severity: Severity;
}

interface Props {
  plan: QueryPlan;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}

export function PlanGraph({ plan, selectedId, onSelect }: Props) {
  const [hover, setHover] = useState<{ placed: Placed; x: number; y: number } | null>(null);

  const { placed, width, height, maxRows, hotspotId } = useMemo(() => {
    // Tidy layout: each leaf takes a column, each parent centres over its children.
    const columns = new Map<string, number>();
    let nextLeaf = 0;

    const assign = (node: PlanNode): number => {
      if (node.children.length === 0) {
        const col = nextLeaf++;
        columns.set(node.id, col);
        return col;
      }
      const childCols = node.children.map(assign);
      const col = (Math.min(...childCols) + Math.max(...childCols)) / 2;
      columns.set(node.id, col);
      return col;
    };
    assign(plan.root);

    const totalWork = plan.totalWorkMs ?? plan.totalMs ?? 0;
    const maxDepth = Math.max(...plan.nodes.map((n) => n.depth));

    const items: Placed[] = plan.nodes.map((node) => {
      const col = columns.get(node.id) ?? 0;
      const rowsOut = node.actualRowsTotal ?? node.estimatedRowsTotal;
      return {
        node,
        x: PAD + col * (CARD_W + COL_GAP),
        // Root at the top, leaves at the bottom: rows flow upward.
        y: PAD + node.depth * (CARD_H + ROW_GAP),
        rowsOut,
        selfShare: totalWork > 0 ? Math.min((node.exclusiveMs ?? 0) / totalWork, 1) : 0,
        severity: severityOf(node, plan.analyzed),
      };
    });

    // The hotspot is the node with the most self time — the thing to fix first.
    const hottest = plan.analyzed
      ? items.reduce<Placed | null>(
          (best, item) =>
            !best || (item.node.exclusiveMs ?? 0) > (best.node.exclusiveMs ?? 0) ? item : best,
          null,
        )
      : null;

    return {
      placed: items,
      width: PAD * 2 + (nextLeaf > 0 ? (nextLeaf - 1) * (CARD_W + COL_GAP) : 0) + CARD_W,
      height: PAD * 2 + maxDepth * (CARD_H + ROW_GAP) + CARD_H,
      maxRows: Math.max(...items.map((i) => i.rowsOut), 1),
      hotspotId: hottest && (hottest.node.exclusiveMs ?? 0) > 0 ? hottest.node.id : null,
    };
  }, [plan]);

  const byId = new Map(placed.map((p) => [p.node.id, p]));

  return (
    <div>
      <div className="graph-wrap">
        <svg
          className="graph"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={
            `Plan graph: ${plan.nodes.length} operations, rows flowing upward from the table scans to the result. ` +
            (hotspotId
              ? `The hotspot is ${describeNode(byId.get(hotspotId)?.node as PlanNode)}.`
              : '')
          }
        >
          {/* Edges first, so cards sit above them. */}
          {placed.map((child) => {
            const parent = child.node.parentId ? byId.get(child.node.parentId) : null;
            if (!parent) return null;

            const x1 = child.x + CARD_W / 2;
            const y1 = child.y;
            const x2 = parent.x + CARD_W / 2;
            const y2 = parent.y + CARD_H;
            const mid = (y1 + y2) / 2;
            const hot = child.rowsOut / maxRows > 0.4;

            return (
              <path
                key={`e-${child.node.id}`}
                className={`graph__edge${hot ? ' graph__edge--hot' : ''}`}
                d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                strokeWidth={edgeWidth(child.rowsOut, maxRows)}
                strokeLinecap="round"
              />
            );
          })}

          {placed.map((item) => (
            <Card
              key={item.node.id}
              item={item}
              plan={plan}
              selected={item.node.id === selectedId}
              isHotspot={item.node.id === hotspotId}
              onSelect={onSelect}
              onHover={(x, y) => setHover({ placed: item, x, y })}
              onLeave={() => setHover(null)}
            />
          ))}
        </svg>
      </div>

      <div className="legend">
        <span className="legend__group">
          <svg width="34" height="16" className="legend__edge" aria-hidden="true">
            <path d="M 2 13 L 32 13" stroke="var(--hairline-strong)" strokeWidth="2" strokeLinecap="round" />
            <path d="M 2 5 L 32 5" stroke="var(--hairline-strong)" strokeWidth="9" strokeLinecap="round" />
          </svg>
          Line thickness = rows flowing
        </span>
        <span className="legend__group">
          <span
            style={{
              width: 34, height: 5, borderRadius: 3,
              background: 'linear-gradient(90deg, var(--accent) 60%, var(--hairline-strong) 60%)',
            }}
            aria-hidden="true"
          />
          Bar = share of total work
        </span>
        <span className="legend__group">
          Estimate error
          <span className="legend__swatches">
            {(['none', 'low', 'mid', 'high'] as Severity[]).map((s) => (
              <span key={s} className="legend__swatch" style={{ background: `var(--sev-${s})` }} />
            ))}
          </span>
          close → 100x off
        </span>
      </div>

      {hover && <Tooltip item={hover.placed} plan={plan} x={hover.x} y={hover.y} />}
    </div>
  );
}

function Card({
  item,
  plan,
  selected,
  isHotspot,
  onSelect,
  onHover,
  onLeave,
}: {
  item: Placed;
  plan: QueryPlan;
  selected: boolean;
  isHotspot: boolean;
  onSelect: (id: string) => void;
  onHover: (x: number, y: number) => void;
  onLeave: () => void;
}) {
  const { node, x, y, selfShare, severity } = item;
  const target = node.relation ?? node.cteName ?? node.functionName ?? node.indexName;
  const barW = CARD_W - 24;

  return (
    <g
      className="graph__node"
      onClick={() => onSelect(node.id)}
      onMouseMove={(e) => onHover(e.clientX, e.clientY)}
      onMouseLeave={onLeave}
    >
      <rect
        x={x}
        y={y}
        width={CARD_W}
        height={CARD_H}
        rx={12}
        className={`graph__card${selected ? ' graph__card--selected' : ''}${
          isHotspot && !selected ? ' graph__card--hotspot' : ''
        }`}
      />

      {/* Severity rail: the estimate-error encoding, kept off the label area. */}
      <rect x={x} y={y + 12} width={3} height={CARD_H - 22} rx={1.5} fill={`var(--sev-${severity})`} />

      <text className="graph__op" x={x + 14} y={y + 21}>
        {truncate(node.nodeType, 22)}
      </text>
      {target && (
        <text className="graph__rel" x={x + 14} y={y + 36}>
          {truncate(target, 24)}
        </text>
      )}

      {/* Self-time bar — the hotspot signal. */}
      <rect className="graph__track" x={x + 14} y={y + 43} width={barW} height={4} rx={2} />
      <rect
        className="graph__fill"
        x={x + 14}
        y={y + 43}
        width={Math.max(barW * selfShare, selfShare > 0 ? 3 : 0)}
        height={4}
        rx={2}
        fill={isHotspot ? 'var(--status-critical)' : 'var(--accent)'}
      />

      <text className="graph__stat" x={x + 14} y={y + 60}>
        {plan.analyzed
          ? `${formatRows(node.actualRowsTotal)} rows · ${formatMs(node.exclusiveMs)}`
          : `${formatRows(node.estimatedRowsTotal)} rows · cost ${node.totalCost.toFixed(0)}`}
      </text>

      {isHotspot && (
        <text className="graph__badge" x={x + CARD_W - 14} y={y + 21} textAnchor="end" fill="var(--status-critical)">
          HOTSPOT
        </text>
      )}
      {node.neverExecuted && (
        <text className="graph__badge" x={x + CARD_W - 14} y={y + 21} textAnchor="end" fill="var(--ink-muted)">
          SKIPPED
        </text>
      )}
    </g>
  );
}

function Tooltip({ item, plan, x, y }: { item: Placed; plan: QueryPlan; x: number; y: number }) {
  const { node } = item;
  const left = Math.min(x + 14, window.innerWidth - 340);
  const top = Math.min(y + 14, window.innerHeight - 220);
  const discarded = (node.rowsRemovedByFilter ?? 0) * (node.loops ?? 1);

  return (
    <div className="tooltip" style={{ left, top }}>
      <div className="tooltip__title">{describeNode(node)}</div>

      {plan.analyzed && !node.neverExecuted ? (
        <>
          <div className="tooltip__row">
            <span>Rows out</span>
            <b>{formatRows(node.actualRowsTotal)}</b>
          </div>
          {discarded > 0 && (
            <div className="tooltip__row">
              <span>Rows discarded</span>
              <b>{formatRows(discarded)}</b>
            </div>
          )}
          <div className="tooltip__row">
            <span>Time here</span>
            <b>
              {formatMs(node.exclusiveMs)} ({formatPercent(item.selfShare)})
            </b>
          </div>
          <div className="tooltip__row">
            <span>Time with children</span>
            <b>{formatMs(node.inclusiveMs)}</b>
          </div>
          {node.loops !== null && node.loops > 1 && (
            <div className="tooltip__row">
              <span>Executions</span>
              <b>{formatRows(node.loops)}</b>
            </div>
          )}
          {node.misestimate !== null && node.misestimate >= 2 && (
            <div className="tooltip__row">
              <span>Estimate</span>
              <b>
                {formatRatio(node.misestimate)} too {node.misestimateDirection === 'over' ? 'high' : 'low'}
              </b>
            </div>
          )}
        </>
      ) : node.neverExecuted ? (
        <div className="tooltip__row">
          <span>Planned but never executed</span>
          <b>—</b>
        </div>
      ) : (
        <>
          <div className="tooltip__row">
            <span>Estimated rows</span>
            <b>{formatRows(node.estimatedRowsTotal)}</b>
          </div>
          <div className="tooltip__row">
            <span>Cost</span>
            <b>{node.totalCost.toFixed(0)}</b>
          </div>
        </>
      )}
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
