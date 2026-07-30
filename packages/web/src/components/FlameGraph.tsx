/**
 * Exclusive-time flame graph.
 *
 * Two encodings, two variables — not one variable encoded twice:
 *   width = self time (where the time actually went)
 *   fill  = cardinality-error severity (why the planner chose this)
 *
 * Fill uses a three-step ordinal ramp rather than a continuous scale, because
 * cells carry labels and every fill/ink pairing has to clear 4.5:1. Buckets are
 * coarse on purpose: the question a flame graph answers is "which node", not
 * "exactly how wrong was the estimate" — that lives in the tooltip.
 */

import { useState } from 'react';
import { formatMs, formatRatio, formatRows, type FlameCell, type FlameLayout, type QueryPlan } from '@query-not/core';

const ROW_HEIGHT = 24;
const ROW_GAP = 2;
const CELL_GAP = 2;
const MIN_LABEL_PX = 54;

type Bucket = 'none' | 'low' | 'mid' | 'high';

/** Coarse severity buckets. Thresholds match the analyzer's warn/critical levels. */
function bucketFor(cell: FlameCell, analyzed: boolean): Bucket {
  if (!analyzed || cell.misestimate === null) return 'none';
  if (cell.misestimate >= 100) return 'high';
  if (cell.misestimate >= 10) return 'mid';
  return 'low';
}

const BUCKET_LABEL: Record<Bucket, string> = {
  none: 'Not measured',
  low: 'Estimate close',
  mid: '10x or worse',
  high: '100x or worse',
};

interface Props {
  layout: FlameLayout;
  plan: QueryPlan;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}

export function FlameGraph({ layout, plan, selectedId, onSelect }: Props) {
  const [hover, setHover] = useState<{ cell: FlameCell; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(880);

  const height = (layout.maxDepth + 1) * (ROW_HEIGHT + ROW_GAP);
  const unit = layout.basis === 'time' ? 'self time' : 'estimated cost';

  return (
    <div>
      <div
        ref={(el) => {
          if (el && el.clientWidth > 0 && Math.abs(el.clientWidth - width) > 1) {
            setWidth(el.clientWidth);
          }
        }}
        style={{ width: '100%' }}
      >
        <svg
          className="flame"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`Flame graph of ${layout.cells.length} plan nodes, sized by ${unit}`}
        >
          {layout.cells.map((cell) => {
            const x = cell.x * width;
            const w = Math.max(cell.width * width - CELL_GAP, cell.width > 0 ? 1 : 0);
            if (w <= 0) return null;

            const y = cell.depth * (ROW_HEIGHT + ROW_GAP);
            const bucket = bucketFor(cell, plan.analyzed);
            const selected = cell.nodeId === selectedId;

            return (
              <g
                key={cell.nodeId}
                className="flame__cell"
                onMouseMove={(e) => setHover({ cell, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelect(cell.nodeId)}
              >
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={ROW_HEIGHT}
                  rx={4}
                  fill={`var(--sev-${bucket})`}
                  stroke={selected ? 'var(--ink)' : 'transparent'}
                  strokeWidth={selected ? 2 : 0}
                />
                {w >= MIN_LABEL_PX && (
                  <text
                    className="flame__label"
                    x={x + 8}
                    y={y + ROW_HEIGHT / 2 + 4}
                    // Inline style, not the `fill` attribute: SVG presentation
                    // attributes do not resolve var(), and a CSS rule would
                    // override the attribute even if they did.
                    style={{ fill: `var(--sev-${bucket}-ink)` }}
                  >
                    {truncate(cell.label, Math.floor((w - 16) / 6.2))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="legend" style={{ marginTop: 'var(--sp-4)' }}>
        <span>
          Width = {unit}
          {layout.basis === 'cost' && ' (plan was not executed)'}
        </span>
        <span className="legend__scale">
          <span>Estimate error</span>
          <span className="legend__swatches">
            {(['none', 'low', 'mid', 'high'] as Bucket[]).map((b) => (
              <span
                key={b}
                className="legend__swatch"
                style={{ background: `var(--sev-${b})` }}
                title={BUCKET_LABEL[b]}
              />
            ))}
          </span>
          <span>close → 100x off</span>
        </span>
      </div>

      {hover && <Tooltip cell={hover.cell} plan={plan} x={hover.x} y={hover.y} basis={layout.basis} />}
    </div>
  );
}

function Tooltip({
  cell,
  plan,
  x,
  y,
  basis,
}: {
  cell: FlameCell;
  plan: QueryPlan;
  x: number;
  y: number;
  basis: 'time' | 'cost';
}) {
  const node = plan.nodes.find((n) => n.id === cell.nodeId);
  // Keep the tooltip on screen near the right and bottom edges.
  const left = Math.min(x + 14, window.innerWidth - 340);
  const top = Math.min(y + 14, window.innerHeight - 190);

  return (
    <div className="tooltip" style={{ left, top }}>
      <div className="tooltip__title">{cell.label}</div>
      <div className="tooltip__row">
        <span>{basis === 'time' ? 'Self time' : 'Self cost'}</span>
        <b>{basis === 'time' ? formatMs(cell.selfValue) : cell.selfValue.toFixed(0)}</b>
      </div>
      <div className="tooltip__row">
        <span>{basis === 'time' ? 'Subtree time' : 'Subtree cost'}</span>
        <b>{basis === 'time' ? formatMs(cell.value) : cell.value.toFixed(0)}</b>
      </div>
      {node && node.actualRowsTotal !== null && (
        <div className="tooltip__row">
          <span>Rows</span>
          <b>
            {formatRows(node.actualRowsTotal)}
            {node.loops && node.loops > 1 ? ` over ${formatRows(node.loops)} loops` : ''}
          </b>
        </div>
      )}
      {cell.misestimate !== null && cell.misestimate >= 2 && node && (
        <div className="tooltip__row">
          <span>Estimate</span>
          <b>
            {formatRows(node.estimatedRowsTotal)} → {formatRatio(cell.misestimate)}{' '}
            {node.misestimateDirection === 'over' ? 'too high' : 'too low'}
          </b>
        </div>
      )}
      {cell.neverExecuted && (
        <div className="tooltip__row">
          <span>Never executed</span>
          <b>—</b>
        </div>
      )}
    </div>
  );
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 1) return '';
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(maxChars - 1, 1))}…`;
}
