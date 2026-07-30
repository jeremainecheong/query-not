/**
 * Plan history for one query.
 *
 * The payoff for the fingerprint and the diff engine, both built for other
 * reasons. A saved-query list is not what anyone actually wants — nobody needs
 * a list of their own SQL. What they want is to know when something that used
 * to be fast stopped being fast, and *what changed*:
 *
 *   "The plan flipped from Index Scan to Seq Scan on 12 July."
 *
 * The chart is a sparkline of cost or time over runs, with the transitions
 * marked. Regressions are listed explicitly rather than left to be spotted in
 * the shape — a change in the series is the signal, not the decoration.
 */

import { useEffect, useState } from 'react';
import { formatMs, formatPercent } from '@query-not/core';

import { api, ApiError, type HistoryReport } from '../api';
import { Link } from '../router';
import { relative } from './SavedPage';

export function HistoryPage({ fingerprint }: { fingerprint: string }) {
  const [report, setReport] = useState<HistoryReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    api
      .history(fingerprint)
      .then(setReport)
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [fingerprint]);

  if (error) return <div className="alert"><div>{error}</div></div>;
  if (!report) return <div className="empty"><p>Loading…</p></div>;

  if (report.points.length === 0) {
    return (
      <div className="empty">
        <p>No runs recorded for this query yet.</p>
      </div>
    );
  }

  const worse = report.regressions.filter((r) => r.worse);

  return (
    <div className="stack stack--tight">
      <section className="verdict">
        <div className="verdict__eyebrow">
          <span className={`dot dot--${worse.length > 0 ? 'critical' : 'good'}`} aria-hidden="true" />
          <span className="t-caption">
            {worse.length > 0
              ? `${worse.length} plan ${worse.length === 1 ? 'regression' : 'regressions'}`
              : 'No regressions'}
          </span>
        </div>
        <h2 className="t-title">Plan history</h2>
        {report.summary && <p className="t-lead verdict__sub">{report.summary}</p>}
        {report.sql && (
          <code className="code" style={{ marginTop: 'var(--sp-4)', display: 'block' }}>
            {report.sql}
          </code>
        )}
      </section>

      <div>
        <div className="section-label">
          <span className="t-caption">Cost over runs</span>
          <div className="section-label__spacer" />
          <span className="t-small">oldest to newest</span>
        </div>
        <div className="group" style={{ padding: 'var(--sp-5)' }}>
          <Sparkline report={report} />
        </div>
      </div>

      {report.regressions.length > 0 && (
        <div>
          <div className="section-label">
            <span className="t-caption">When the plan changed</span>
          </div>
          <div className="group">
            {report.regressions
              .slice()
              .reverse()
              .map((r) => (
                <div className="group__row finding" key={`${r.fromSlug}-${r.toSlug}`}>
                  <div
                    className={`finding__icon finding__icon--${r.worse ? 'critical' : 'info'}`}
                    aria-hidden="true"
                  >
                    {r.worse ? '!' : '↓'}
                  </div>
                  <div>
                    <div className="finding__title">
                      {r.worse ? 'Got worse' : 'Improved'} — {relative(r.toAt)}
                    </div>
                    <div className="finding__detail">{r.headline}</div>
                    {r.accessChanges.length > 0 && (
                      <ul className="changes">
                        {r.accessChanges.slice(0, 3).map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    )}
                    <div className="finding__evidence">
                      <span className="chip">
                        cost <b>{r.costBefore.toFixed(0)} → {r.costAfter.toFixed(0)}</b>
                      </span>
                      {r.timeChange !== null && (
                        <span className="chip">
                          time <b>{r.timeChange > 0 ? '+' : ''}{formatPercent(r.timeChange)}</b>
                        </span>
                      )}
                      <Link className="chip" to={{ name: 'analysis', slug: r.toSlug }}>
                        open this run
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      <div>
        <div className="section-label">
          <span className="t-caption">Every run</span>
          <div className="section-label__spacer" />
          <span className="t-small">{report.points.length} recorded</span>
        </div>
        <div className="group">
          {report.points
            .slice()
            .reverse()
            .map((p) => (
              <Link className="tree__row" to={{ name: 'analysis', slug: p.slug }} key={p.slug}>
                <span className="tree__label">
                  <span className="tree__name">{p.rootNode}</span>
                  <span className="tree__rel">{p.accessMethods[0] ?? ''}</span>
                </span>
                <span className="tree__metrics">
                  <span className="chip">
                    {p.analyzed && p.totalMs !== null ? formatMs(p.totalMs) : `cost ${p.totalCost.toFixed(0)}`}
                  </span>
                  <span className="chip">{relative(p.createdAt)}</span>
                </span>
              </Link>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Cost per run, oldest to newest, with the runs that changed the plan marked.
 *
 * Cost rather than time, because cost is available on every run — an
 * estimate-only run has no timing, and a series with holes in it is worse than
 * a series measuring something slightly less direct.
 */
function Sparkline({ report }: { report: HistoryReport }) {
  const points = report.points;
  const width = 720;
  const height = 132;
  const pad = { top: 14, right: 14, bottom: 22, left: 52 };

  const values = points.map((p) => p.totalCost);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  const x = (i: number) =>
    pad.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * (width - pad.left - pad.right));
  const y = (v: number) => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);

  const changed = new Set(report.regressions.map((r) => r.toSlug));
  const worse = new Set(report.regressions.filter((r) => r.worse).map((r) => r.toSlug));

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.totalCost)}`).join(' ');

  return (
    <div className="graph-wrap">
      <svg
        className="graph"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Estimated cost across ${points.length} runs. ${report.summary ?? ''}`}
      >
        <line
          x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom}
          stroke="var(--hairline-strong)" strokeWidth="1"
        />
        <text x={pad.left - 8} y={pad.top + 4} textAnchor="end" className="graph__stat">
          {max.toFixed(0)}
        </text>
        <text x={pad.left - 8} y={height - pad.bottom} textAnchor="end" className="graph__stat">
          {min.toFixed(0)}
        </text>

        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />

        {points.map((p, i) => (
          <circle
            key={p.slug}
            cx={x(i)}
            cy={y(p.totalCost)}
            r={changed.has(p.slug) ? 5 : 3}
            fill={worse.has(p.slug) ? 'var(--status-critical)' : changed.has(p.slug) ? 'var(--status-good)' : 'var(--accent)'}
            stroke="var(--surface)"
            strokeWidth="2"
          >
            <title>
              {`${p.rootNode} — cost ${p.totalCost.toFixed(0)}${p.totalMs !== null ? `, ${formatMs(p.totalMs)}` : ''} (${relative(p.createdAt)})`}
            </title>
          </circle>
        ))}
      </svg>

      <div className="legend">
        <span className="legend__group">
          <span className="dot dot--critical" aria-hidden="true" /> plan got worse
        </span>
        <span className="legend__group">
          <span className="dot dot--good" aria-hidden="true" /> plan changed for the better
        </span>
        <span className="legend__group">estimated cost, oldest run on the left</span>
      </div>
    </div>
  );
}
