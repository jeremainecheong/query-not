/**
 * Workload-level index consolidation.
 *
 * The per-query Indexes tab answers "what helps this statement"; this section
 * answers "what is the smallest set of indexes that serves the window". Each
 * candidate arrives already proven — re-planned against every in-scope
 * statement with a hypothetical index — so a card here is a verdict with its
 * evidence attached, not a suggestion.
 */

import { useState } from 'react';
import { formatPercent } from '@query-not/core';
import {
  api,
  ApiError,
  type ConsolidationCandidate,
  type ConsolidationPerQuery,
  type ConsolidationReport,
} from '../api';

type State =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; report: ConsolidationReport }
  | { status: 'error'; message: string; hint: string | null };

export function Consolidation({ canConsolidate }: { canConsolidate: boolean }) {
  const [includeSaved, setIncludeSaved] = useState(true);
  const [state, setState] = useState<State>({ status: 'idle' });

  async function run() {
    setState({ status: 'running' });
    try {
      setState({ status: 'done', report: await api.consolidateWorkload({ includeSaved }) });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    }
  }

  return (
    <div className="consolidation" style={{ marginTop: 'var(--sp-6)' }}>
      <div className="section-label">
        <span className="t-caption">Consolidation</span>
        <div className="section-label__spacer" />
        <span className="t-small">one index, many queries</span>
      </div>

      <div className="group">
        <div className="group__row">
          <p className="t-body" style={{ color: 'var(--ink-secondary)', maxWidth: '68ch' }}>
            Merge this window’s index demands into a few composite candidates, then prove each one
            against every statement it claims to serve — including the ones it does not, so a
            regression cannot hide.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
            <button
              className="btn btn--small"
              onClick={() => void run()}
              disabled={!canConsolidate || state.status === 'running'}
              title={
                canConsolidate
                  ? 'Extract per-relation demands, merge them, and prove each candidate hypothetically'
                  : 'Requires the hypopg extension on the target database'
              }
            >
              {state.status === 'running' ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Proving candidates
                </>
              ) : (
                'Find one index for many queries'
              )}
            </button>

            <label className="toggle" title="A saved query with real literals stands in for a $1-normalised workload entry">
              <input
                type="checkbox"
                checked={includeSaved}
                onChange={(e) => setIncludeSaved(e.target.checked)}
              />
              Use saved queries as runnable stand-ins for normalised statements
            </label>
          </div>

          {!canConsolidate && (
            <p className="t-small" style={{ marginTop: 'var(--sp-3)', color: 'var(--ink-muted)' }}>
              Install the hypopg extension to test consolidated indexes without building them.
            </p>
          )}
        </div>

        {state.status === 'error' && (
          <div className="group__row">
            <div className="proof">
              <div className="proof__verdict">
                <span className="dot dot--critical" aria-hidden="true" />
                Could not consolidate
              </div>
              <div className="proof__headline">{state.message}</div>
              {state.hint && <div className="proof__note">{state.hint}</div>}
            </div>
          </div>
        )}

        {state.status === 'done' && <Report report={state.report} />}
      </div>
    </div>
  );
}

function Report({ report }: { report: ConsolidationReport }) {
  return (
    <>
      <div className="group__row consolidation__summary">
        <p className="t-body" style={{ color: 'var(--ink-secondary)' }}>{report.summary}</p>
      </div>

      {report.candidates.map((candidate) => (
        <CandidateCard key={candidate.ddl} candidate={candidate} />
      ))}

      {report.scope.skipped.length > 0 && (
        <div className="group__row">
          <details className="consolidation__skipped">
            <summary className="t-small" style={{ cursor: 'pointer' }}>
              {report.scope.skipped.length} statement{report.scope.skipped.length === 1 ? '' : 's'} skipped —
              with reasons
            </summary>
            {report.scope.skipped.map((s, i) => (
              <div key={`${s.queryId ?? s.savedName ?? i}`} style={{ marginTop: 'var(--sp-3)' }}>
                <div className="workload-row__meta">
                  <span className="pill">{s.savedName ?? (s.queryId ? `query ${s.queryId}` : 'saved')}</span>
                  <span>{formatPercent(s.share)} of window</span>
                </div>
                <p className="workload-row__caveat">
                  {s.reason}
                  {s.hint ? ` ${s.hint}` : ''}
                </p>
              </div>
            ))}
          </details>
        </div>
      )}
    </>
  );
}

function CandidateCard({ candidate }: { candidate: ConsolidationCandidate }) {
  const improved = candidate.verdict === 'improved';
  const regressed = candidate.verdict === 'regressed';

  return (
    <div className="group__row consolidation__candidate">
      <div className="proof__verdict">
        <span
          className={`dot dot--${improved ? 'good' : regressed ? 'critical' : 'muted'}`}
          aria-hidden="true"
        />
        {improved
          ? 'Proven across the workload'
          : regressed
            ? 'Made something worse — do not apply'
            : 'No effect'}
      </div>

      <code className="code" style={{ display: 'block', marginTop: 'var(--sp-3)' }}>{candidate.ddl}</code>

      <div className="proof__headline">{candidate.summary}</div>
      <div className="suggestion__reason">{candidate.rationale}</div>

      {candidate.replaces.length > 0 && (
        <div className="suggestion__reason" style={{ color: 'var(--ink-muted)' }}>
          Would replace{' '}
          {candidate.replaces.map((r) => `${r.relation} (${r.columns.join(', ')})`).join('; ')}.
        </div>
      )}

      <details className="consolidation__matrix" style={{ marginTop: 'var(--sp-3)' }}>
        <summary className="t-small" style={{ cursor: 'pointer' }}>
          Per-query proof — {candidate.perQuery.length} statement
          {candidate.perQuery.length === 1 ? '' : 's'}
        </summary>
        {candidate.perQuery.map((row) => (
          <PerQueryRow key={row.fingerprint} row={row} />
        ))}
      </details>

      <div className="proof__note">{candidate.note}</div>
    </div>
  );
}

function PerQueryRow({ row }: { row: ConsolidationPerQuery }) {
  const improved = row.verdict === 'improved';
  const regressed = row.verdict === 'regressed';
  const worst = Math.max(row.costBefore ?? 0, row.costAfter ?? 0, 1);

  return (
    <div className="consolidation__row" style={{ marginTop: 'var(--sp-4)' }}>
      <div className="workload-row__meta">
        <span className="pill" title={row.claimed ? 'This candidate claims to serve this statement' : 'Re-planned only to check for regressions'}>
          {row.claimed ? 'claimed' : 'sentinel'}
        </span>
        <span>{formatPercent(row.share)} of window</span>
        <span>·</span>
        <span>{row.savedName ?? (row.queryId ? `query ${row.queryId}` : row.fingerprint.slice(0, 48))}</span>
      </div>

      {row.error ? (
        <p className="workload-row__caveat">{row.error}</p>
      ) : (
        <>
          <div className="proof__headline">{row.headline}</div>
          {row.costBefore !== null && row.costAfter !== null && (
            <div className="compare" style={{ marginTop: 'var(--sp-2)' }}>
              <div className="compare__bar">
                <div className="compare__label">
                  <span>Before</span>
                  <span>{row.costBefore.toFixed(0)}</span>
                </div>
                <div className="compare__track">
                  <div
                    className="compare__fill"
                    style={{ width: `${(row.costBefore / worst) * 100}%`, background: 'var(--ink-muted)' }}
                  />
                </div>
              </div>
              <div className="compare__bar">
                <div className="compare__label">
                  <span>After</span>
                  <span>{row.costAfter.toFixed(0)}</span>
                </div>
                <div className="compare__track">
                  <div
                    className="compare__fill"
                    style={{
                      width: `${(row.costAfter / worst) * 100}%`,
                      background: improved
                        ? 'var(--status-good)'
                        : regressed
                          ? 'var(--status-critical)'
                          : 'var(--ink-muted)',
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
