/**
 * The landing page.
 *
 * A bare composer is a tool; this is the front door. It answers "what is this
 * and where do I go" in one screen, then gets out of the way — the primary
 * action is still analysing a query, so that is the first thing you can click.
 *
 * Recent activity is here rather than on its own page because an empty portal
 * is a bad first impression and a portal that shows your last few runs is a
 * useful one.
 */

import { useEffect, useState } from 'react';
import { formatMs } from '@query-not/core';

import { api, type AnalysisSummary, type Health } from '../api';
import { Link } from '../router';
import { relative } from './SavedPage';

export function LandingPage({ health }: { health: Health | null }) {
  const [recent, setRecent] = useState<AnalysisSummary[]>([]);

  useEffect(() => {
    api.recentAnalyses(6).then((r) => setRecent(r.analyses)).catch(() => setRecent([]));
  }, []);

  const connected = health?.database.connected ?? false;

  return (
    <div className="stack">
      <section className="hero">
        <h1 className="t-hero hero__title">
          Prove the fix before you ship it.
        </h1>
        <p className="t-lead hero__sub">
          query-not reads a Postgres plan, finds what is actually costing you time, then
          re-plans the query against a hypothetical index to show whether the fix works —
          without building anything.
        </p>

        <div className="hero__actions">
          <Link className="btn btn--primary" to={{ name: 'analyse' }}>
            Analyse a query
          </Link>
          <Link className="btn" to={{ name: 'reference' }}>
            Browse plan operations
          </Link>
        </div>

        {health && (
          <div className="hero__status">
            <span className={`dot dot--${connected ? 'good' : 'critical'}`} aria-hidden="true" />
            {connected ? (
              <>
                Connected to <b>{health.database.database}</b>
                {health.database.readOnlyRole && ' · read-only role'}
                {!health.capabilities.whatIfIndex && ' · hypopg not installed'}
              </>
            ) : (
              <>Not connected — start the agent with <code>npm run agent</code></>
            )}
          </div>
        )}
      </section>

      <section className="cards">
        <Card
          to={{ name: 'analyse' }}
          title="Analyse"
          body="Paste a query. Get the hotspot, the wasted work, and index suggestions that are tested before they are shown."
        />
        <Card
          to={{ name: 'workload' }}
          title="Workload"
          body="What the server is actually spending its day on, ranked by total time — not the slow query everyone notices, the cheap one running constantly."
        />
        <Card
          to={{ name: 'queries' }}
          title="Query history"
          body="Every run is recorded. When a plan changes shape — an index scan becoming a sequential scan — you can see exactly when."
          count={health?.store?.queries}
          countLabel="queries seen"
        />
        <Card
          to={{ name: 'saved' }}
          title="Saved"
          body="Name the queries you care about so their history is easy to find later."
          count={health?.store?.savedQueries}
          countLabel="saved"
        />
        <Card
          to={{ name: 'decisions' }}
          title="Decisions"
          body="What was tested, what it concluded, and whether it ever shipped. The reasoning survives the person who did the testing."
        />
        <Card
          to={{ name: 'reference' }}
          title="Reference"
          body="Every plan operation, illustrated: what it does, why the planner chose it, and how it goes wrong."
        />
      </section>

      {recent.length > 0 && (
        <section>
          <div className="section-label">
            <span className="t-caption">Recent runs</span>
            <div className="section-label__spacer" />
            <Link className="t-small" to={{ name: 'queries' }}>
              All queries
            </Link>
          </div>
          <div className="group">
            {recent.map((a) => (
              <Link className="tree__row" to={{ name: 'analysis', slug: a.slug }} key={a.slug}>
                <span className="tree__label">
                  <span className="tree__name">{firstLine(a.sql)}</span>
                </span>
                <span className="tree__metrics">
                  <span className="chip">
                    {a.analyzed && a.totalMs !== null ? formatMs(a.totalMs) : `cost ${a.totalCost.toFixed(0)}`}
                  </span>
                  <span className="chip">{relative(a.createdAt)}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Card({
  to,
  title,
  body,
  count,
  countLabel,
}: {
  to: Parameters<typeof Link>[0]['to'];
  title: string;
  body: string;
  count?: number;
  countLabel?: string;
}) {
  return (
    <Link className="card-tile" to={to}>
      <div className="card-tile__title">{title}</div>
      <p className="card-tile__body">{body}</p>
      {count !== undefined && count > 0 && (
        <div className="card-tile__count">
          <b>{count}</b> {countLabel}
        </div>
      )}
    </Link>
  );
}

export function firstLine(sql: string): string {
  const line = sql.trim().split('\n')[0] ?? sql;
  return line.length > 76 ? `${line.slice(0, 75)}…` : line;
}
