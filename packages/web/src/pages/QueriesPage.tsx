/**
 * Every query seen, not every run.
 *
 * Grouped by fingerprint, because "the same query with different literals" is
 * one thing to a person and a thousand rows to a database. Sorted so the ones
 * whose plans have changed float to the top — a list of queries is only
 * interesting for the ones that moved.
 */

import { useEffect, useState } from 'react';
import { formatMs } from '@query-not/core';

import { api, type QueryGroup } from '../api';
import { Link } from '../router';
import { relative } from './SavedPage';
import { firstLine } from './LandingPage';

export function QueriesPage() {
  const [groups, setGroups] = useState<QueryGroup[] | null>(null);

  useEffect(() => {
    api.queries().then((r) => setGroups(r.queries)).catch(() => setGroups([]));
  }, []);

  if (!groups) return <div className="empty"><p>Loading…</p></div>;

  if (groups.length === 0) {
    return (
      <div className="stack stack--tight">
        <section className="verdict">
          <h2 className="t-title">Query history</h2>
        </section>
        <div className="empty">
          <p>
            No queries recorded yet. Every query you analyse is kept here, so their plan
            history builds up without anyone having to remember.
          </p>
        </div>
      </div>
    );
  }

  const changed = groups.filter((g) => g.regressions > 0);

  return (
    <div className="stack stack--tight">
      <section className="verdict">
        <div className="verdict__eyebrow">
          <span className={`dot dot--${changed.length > 0 ? 'critical' : 'good'}`} aria-hidden="true" />
          <span className="t-caption">
            {changed.length > 0
              ? `${changed.length} with plan changes`
              : 'No plan changes'}
          </span>
        </div>
        <h2 className="t-title">Query history</h2>
        <p className="t-lead verdict__sub">
          {groups.length} {groups.length === 1 ? 'query' : 'queries'} recorded.
          {changed.length > 0
            ? ' The ones whose plans have changed are listed first — a plan that moves without the query moving means the data or the statistics did.'
            : ' No plan has changed shape since it was first recorded.'}
        </p>
      </section>

      <div className="group">
        {groups.map((g) => (
          <Link
            className="group__row group__row--interactive query-row"
            to={{ name: 'history', fingerprint: g.fingerprint }}
            key={g.fingerprint}
          >
            <div className="query-row__main">
              <code className="code query-row__sql">{firstLine(g.sql)}</code>
              <div className="query-row__meta">
                <span>{g.runs} {g.runs === 1 ? 'run' : 'runs'}</span>
                <span>·</span>
                <span>last {relative(g.lastSeen)}</span>
                {g.savedAs && (
                  <>
                    <span>·</span>
                    <span>saved as “{g.savedAs}”</span>
                  </>
                )}
              </div>
            </div>

            <div className="query-row__stats">
              {g.regressions > 0 && (
                <span className="pill">
                  <span className="dot dot--critical" aria-hidden="true" />
                  {g.regressions} plan {g.regressions === 1 ? 'change' : 'changes'}
                </span>
              )}
              <span className="chip">
                {g.lastMs !== null ? formatMs(g.lastMs) : `cost ${g.lastCost.toFixed(0)}`}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
