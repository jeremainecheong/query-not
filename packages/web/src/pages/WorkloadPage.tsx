/**
 * The workload — what the server is actually spending its day on.
 *
 * Ranked by *total* time, never mean. That single choice is the reason this
 * page exists: a slow-query log shows you the eight-second report everyone
 * complains about, and never shows you the 4ms query running two million times
 * a day that costs three times as much. Only one of those is worth fixing
 * first, and it is usually not the one anyone is complaining about.
 */

import { useEffect, useState } from 'react';
import { formatMs, formatPercent, formatRows } from '@query-not/core';

import { api, ApiError, type WorkloadResponse } from '../api';
import { relative } from './SavedPage';

const FLAG_LABEL: Record<string, string> = {
  dominant: 'dominates',
  'high-frequency': 'high frequency',
  unstable: 'unstable plan',
  'cold-cache': 'cold cache',
};

export function WorkloadPage({ onAnalyse }: { onAnalyse: (sql: string) => void }) {
  const [data, setData] = useState<WorkloadResponse | null>(null);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setData(await api.workload());
      setError(null);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function snapshot() {
    setBusy(true);
    try {
      await api.workloadSnapshot();
      await load();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="alert">
        <div>{error.message}</div>
        {error.hint && <div className="alert__hint">{error.hint}</div>}
      </div>
    );
  }

  if (!data) return <div className="empty"><p>Loading…</p></div>;

  if (!data.availability.installed) {
    return (
      <div className="stack stack--tight">
        <section className="verdict">
          <h2 className="t-title">Workload</h2>
          <p className="t-lead verdict__sub">{data.availability.reason}</p>
        </section>
        <div className="group" style={{ padding: 'var(--sp-5)' }}>
          <p className="t-body" style={{ color: 'var(--ink-secondary)' }}>
            {data.availability.hint}
          </p>
          <p className="t-small" style={{ marginTop: 'var(--sp-4)' }}>
            Without it, query-not can still analyse anything you paste — it just cannot tell
            you <em>which</em> queries are worth pasting.
          </p>
        </div>
      </div>
    );
  }

  const w = data.window;
  const top = w?.entries ?? [];

  return (
    <div className="stack stack--tight">
      <section className="verdict">
        <div className="verdict__eyebrow">
          <span className="dot dot--good" aria-hidden="true" />
          <span className="t-caption">
            {w?.isDelta ? `Window since ${relative(w.fromAt as string)}` : 'Cumulative since last reset'}
          </span>
        </div>
        <h2 className="t-title">Workload</h2>
        <p className="t-lead verdict__sub">
          {w?.isDelta ? (
            <>
              {formatMs(w.totalMs)} of query time across {top.length} statements in this window,
              ranked by total time rather than mean — the cheap query running constantly usually
              costs more than the slow one everybody notices.
            </>
          ) : (
            <>
              These are cumulative counters, not a window. Take a second snapshot and the next
              view will show what happened between them.
            </>
          )}
        </p>

        <div className="metrics">
          <button className="btn btn--small" onClick={() => void snapshot()} disabled={busy}>
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" /> Sampling
              </>
            ) : (
              'Take snapshot'
            )}
          </button>
          <span>
            <b>{data.snapshots}</b> snapshot{data.snapshots === 1 ? '' : 's'} recorded
          </span>
          {w?.resetDetected && (
            <span className="pill">
              <span className="dot dot--warning" aria-hidden="true" />
              counters were reset in this window
            </span>
          )}
        </div>
      </section>

      {top.length === 0 ? (
        <div className="empty">
          <p>
            No statements ran between the last two snapshots. Take another snapshot after some
            traffic has gone through.
          </p>
        </div>
      ) : (
        <div className="group">
          {top.slice(0, 30).map((e) => (
            <div className="group__row workload-row" key={e.queryId}>
              <div className="workload-row__bar" aria-hidden="true">
                <span style={{ width: `${Math.max(e.share * 100, 1.5)}%` }} />
              </div>

              <div className="workload-row__main">
                <code className="code workload-row__sql">{e.query}</code>

                <div className="workload-row__meta">
                  <span>
                    <b>{formatMs(e.totalMs)}</b> total
                  </span>
                  <span>·</span>
                  <span>
                    <b>{formatRows(e.calls)}</b> calls
                  </span>
                  <span>·</span>
                  <span>
                    <b>{formatMs(e.meanMs)}</b> each
                  </span>
                  <span>·</span>
                  <span>
                    <b>{formatPercent(e.share)}</b> of window
                  </span>
                </div>

                {e.flags.length > 0 && (
                  <div className="workload-row__flags">
                    {e.flags.map((f) => (
                      <span className="pill" key={f}>
                        {FLAG_LABEL[f] ?? f}
                      </span>
                    ))}
                  </div>
                )}

                {e.note && <p className="workload-row__note">{e.note}</p>}

                {!e.explainable && (
                  <p className="workload-row__caveat">{e.notExplainableReason}</p>
                )}
              </div>

              <div className="workload-row__actions">
                <button
                  className="btn btn--small"
                  onClick={() => onAnalyse(e.query)}
                  title={
                    e.explainable
                      ? 'Analyse this query'
                      : 'Opens in the composer — substitute real parameters before running it'
                  }
                >
                  {e.explainable ? 'Analyse' : 'Open'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
