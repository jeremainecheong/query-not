/**
 * Parameter sensitivity.
 *
 * One button: re-plan the query at constants drawn from the column's own
 * pg_stats (histogram positions for ranges, MCV frequencies for equalities)
 * and show where the plan flips. Everything on this panel is a planner
 * estimate — the endpoint never executes anything, by design, and the
 * standing note at the bottom says why.
 *
 * The agent picks the predicate (largest table by pg_class.reltuples, with the
 * why sentence shown) but returns every candidate it saw, skipped ones with
 * their reasons — nothing is silently dropped. Per-variant payloads are
 * summaries; the two plans flanking the first flip carry their full diff,
 * rendered behind a details expansion. This panel deliberately does not reuse
 * Proof: that renders a WhatIfResult and would misdescribe the change.
 */

import { useState } from 'react';
import { formatRows } from '@query-not/core';
import { api, ApiError, type SensitivityResult, type SensitivityVariant } from '../api';

type State =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: SensitivityResult }
  | { status: 'error'; message: string; hint: string | null };

export function Sensitivity({ sql, canRun }: { sql: string; canRun: boolean }) {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function run() {
    setState({ status: 'running' });
    try {
      const result = await api.sensitivity(sql);
      setState({ status: 'done', result });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    }
  }

  return (
    <div className="group__row sweep">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <button
          className="btn btn--small"
          onClick={() => void run()}
          disabled={!canRun || state.status === 'running'}
          title={
            canRun
              ? 'Re-plan this query at constants drawn from pg_stats — estimates only, nothing executes'
              : 'Requires a database connection'
          }
        >
          {state.status === 'running' ? (
            <>
              <span className="spinner" aria-hidden="true" /> Sweeping
            </>
          ) : (
            'Sweep the constant'
          )}
        </button>
        <span className="t-small" style={{ color: 'var(--ink-muted)' }}>
          The same query, planned at several constants from the planner’s own statistics — the plan
          that flips (or refuses to) is the cost model showing its work.
        </span>
      </div>

      {state.status === 'error' && (
        <div className="proof" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="proof__verdict">
            <span className="dot dot--critical" aria-hidden="true" />
            Could not sweep
          </div>
          <div className="proof__headline">{state.message}</div>
          {state.hint && <div className="proof__note">{state.hint}</div>}
        </div>
      )}

      {state.status === 'done' && <SweepResult result={state.result} />}
    </div>
  );
}

function SweepResult({ result }: { result: SensitivityResult }) {
  const { predicate, candidates, basis, baseline, variants, flips } = result;
  const skipped = candidates.filter((c) => c.skipped !== null);
  const rows: SensitivityVariant[] = [baseline, ...variants];

  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      <div className="suggestion__head">
        <code className="code">
          {predicate.relation.join('.')}.{predicate.column} {predicate.operator} {predicate.originalValue}
        </code>
      </div>
      <div className="suggestion__reason">{sentence(predicate.why)}</div>

      {(candidates.length > 1 || skipped.length > 0) && (
        <ul className="changes" style={{ marginTop: 'var(--sp-3)' }}>
          {candidates.map((c, i) => (
            <li key={i}>
              <span>
                <code className="code" style={{ padding: '0 4px' }}>
                  {c.column ?? '?'} {c.operator ?? '?'} {c.value ?? '…'}
                </code>{' '}
                {c.chosen ? '— swept' : c.skipped ? `— skipped: ${c.skipped}` : '— eligible'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="proof__note" style={{ marginTop: 'var(--sp-3)' }}>
        {sentence(basis.evidence)}
      </div>

      <div style={{ overflowX: 'auto', marginTop: 'var(--sp-4)' }}>
        <table className="sweep__table" style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              {['Point', 'Value', 'Est. rows', 'Est. cost', 'Access path (estimates — nothing executed)'].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    padding: '6px 10px 6px 0',
                    color: 'var(--ink-muted)',
                    fontWeight: 500,
                    borderBottom: '1px solid var(--hairline)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.label} className="sweep__row">
                <td style={cell({ whiteSpace: 'nowrap', fontWeight: v.label === 'as written' ? 600 : 400 })}>
                  {v.label}
                  {v.frequency !== null && (
                    <span style={{ color: 'var(--ink-muted)' }}> · {(v.frequency * 100).toFixed(1)}%</span>
                  )}
                </td>
                <td style={cell({ fontFamily: 'var(--mono)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}>
                  {v.value}
                </td>
                <td style={cell({ fontVariantNumeric: 'tabular-nums' })}>{formatRows(v.estimatedRows)}</td>
                <td style={cell({ fontVariantNumeric: 'tabular-nums' })}>{v.totalCost.toFixed(0)}</td>
                <td style={cell({})}>{v.signature.join(' · ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {flips.map((flip, i) => (
        <div className="proof sweep__flip" key={i} style={{ marginTop: 'var(--sp-4)' }}>
          <div className="proof__verdict">
            <span className="dot dot--warning" aria-hidden="true" />
            The plan flips between {flip.fromLabel} and {flip.toLabel}
          </div>
          <div className="proof__headline">{flip.headline}</div>
        </div>
      ))}
      {flips.length === 0 && (
        <div className="proof sweep__noflip" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="proof__verdict">
            <span className="dot dot--muted" aria-hidden="true" />
            No flip — every sweep point planned the same way
          </div>
        </div>
      )}

      <p className="t-body" style={{ color: 'var(--ink-secondary)', marginTop: 'var(--sp-4)', maxWidth: '72ch' }}>
        {result.narrative}
      </p>

      {variants
        .filter((v) => v.diff !== null)
        .map((v) => (
          <VariantDiff key={v.label} variant={v} />
        ))}

      <div className="proof__note" style={{ marginTop: 'var(--sp-4)' }}>{result.note}</div>
    </div>
  );
}

/** Node-level diff vs the as-written plan, for a flip-flanking variant. */
function VariantDiff({ variant }: { variant: SensitivityVariant }) {
  const [open, setOpen] = useState(false);
  const changed = (variant.diff?.nodes ?? []).filter((n) => n.status !== 'unchanged');
  if (changed.length === 0) return null;

  return (
    <div className="diff">
      <button className="btn btn--ghost btn--small diff__toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {variant.label} vs as written — {changed.length} node
        {changed.length === 1 ? '' : 's'} changed
      </button>
      {open && (
        <div className="diff__body">
          {changed.map((node, i) => (
            <div className="diff__row" key={i}>
              <span className={`diff__badge diff__badge--${node.status}`}>
                {node.status === 'added' ? '+' : node.status === 'removed' ? '−' : '~'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="diff__label" style={{ paddingLeft: node.depth * 12 }}>
                  {node.label}
                </div>
                <ul className="changes">
                  {node.changes.map((change, j) => (
                    <li key={j}>{change}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const cell = (extra: React.CSSProperties): React.CSSProperties => ({
  padding: '6px 10px 6px 0',
  borderBottom: '1px solid var(--hairline)',
  verticalAlign: 'top',
  ...extra,
});

const sentence = (s: string): string =>
  s.length > 0 ? `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : s;
