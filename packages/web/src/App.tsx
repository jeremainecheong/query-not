import { useEffect, useMemo, useState } from 'react';
import { formatMs, formatPercent, formatRows, type Finding } from '@query-not/core';

import { api, ApiError, type Analysis, type Health } from './api';
import { Link, useRouter } from './router';
import { SavedPage } from './pages/SavedPage';
import { HistoryPage } from './pages/HistoryPage';
import { LandingPage } from './pages/LandingPage';
import { QueriesPage } from './pages/QueriesPage';
import { ReferencePage } from './pages/ReferencePage';
import { WorkloadPage } from './pages/WorkloadPage';
import { IndexesPage } from './pages/IndexesPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { CommandPalette } from './components/CommandPalette';
import { FlameGraph } from './components/FlameGraph';
import { Findings } from './components/Findings';
import { Hotspots } from './components/Hotspots';
import { NodeDetail, PlanTree } from './components/PlanTree';
import { PlanGraph } from './components/PlanGraph';
import { Rewrites } from './components/Rewrites';
import { StatisticsAdvice } from './components/StatisticsAdvice';
import { Sensitivity } from './components/Sensitivity';
import { Suggestions } from './components/Suggestions';
import { WhatIfSettings } from './components/WhatIfSettings';

/*
 * A join and an aggregate rather than a single scan: a two-node plan makes any
 * plan visualisation look pointless, and the row-flow encoding only means
 * something when there is flow to show.
 */
const SAMPLE = `SELECT c.country, count(*) AS orders, sum(o.total_cents) AS cents
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'complete'
GROUP BY c.country
ORDER BY cents DESC`;

type Theme = 'system' | 'light' | 'dark';
type Tab = 'graph' | 'findings' | 'rewrites' | 'indexes' | 'settings' | 'sensitivity' | 'plan';

export function App() {
  const [sql, setSql] = useState(SAMPLE);
  const [measure, setMeasure] = useState(true);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [theme, setTheme] = useState<Theme>('system');
  const [tab, setTab] = useState<Tab>('graph');
  const [saveName, setSaveName] = useState('');
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const { route, navigate } = useRouter();

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  // A shared link resolves to a recorded analysis; load it and show it exactly
  // as it was, without re-running anything against the database.
  useEffect(() => {
    if (route.name !== 'analysis') return;
    setRunning(true);
    setError(null);
    api
      .getAnalysis(route.slug)
      .then((result) => {
        setAnalysis(result);
        if (result.sql) setSql(result.sql);
        setSelectedId(null);
        setTab('graph');
      })
      .catch((err) => {
        setAnalysis(null);
        setError({
          message: err instanceof Error ? err.message : String(err),
          hint: err instanceof ApiError ? err.hint : null,
        });
      })
      .finally(() => setRunning(false));
  }, [route.name, route.name === 'analysis' ? route.slug : null]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const result = await api.analyze(sql, measure);
      setAnalysis(result);
      setSelectedId(null);
      setTab('graph');
      setSavedNotice(null);
      // Replace rather than push: re-running a query should not stack history
      // entries the back button has to walk through.
      if (result.slug) navigate({ name: 'analysis', slug: result.slug }, { replace: true });
    } catch (err) {
      setAnalysis(null);
      setError({
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    } finally {
      setRunning(false);
    }
  }

  async function saveQuery() {
    const name = saveName.trim();
    if (!name) return;
    try {
      await api.save(name, sql);
      setSavedNotice(`Saved as “${name}”.`);
      setSaveName('');
    } catch (err) {
      setSavedNotice(err instanceof Error ? err.message : 'Could not save.');
    }
  }

  const selectedNode = useMemo(
    () => analysis?.plan.nodes.find((n) => n.id === selectedId) ?? null,
    [analysis, selectedId],
  );

  const connected = health?.database.connected ?? false;

  return (
    <div className="app">
      <CommandPalette />
      <header className="header">
        <Link className="header__mark" to={{ name: 'home' }}>
          query<span>-not</span>
        </Link>
        <nav className="header__nav">
          <Link
            className={`header__link${route.name === 'analyse' || route.name === 'analysis' ? ' header__link--active' : ''}`}
            to={{ name: 'analyse' }}
          >
            Analyse
          </Link>
          <Link
            className={`header__link${route.name === 'workload' ? ' header__link--active' : ''}`}
            to={{ name: 'workload' }}
          >
            Workload
          </Link>
          <Link
            className={`header__link${route.name === 'indexes' ? ' header__link--active' : ''}`}
            to={{ name: 'indexes' }}
          >
            Indexes
          </Link>
          <Link
            className={`header__link${route.name === 'queries' || route.name === 'history' ? ' header__link--active' : ''}`}
            to={{ name: 'queries' }}
          >
            History
          </Link>
          <Link
            className={`header__link${route.name === 'saved' ? ' header__link--active' : ''}`}
            to={{ name: 'saved' }}
          >
            Saved
          </Link>
          <Link
            className={`header__link${route.name === 'reference' ? ' header__link--active' : ''}`}
            to={{ name: 'reference' }}
          >
            Reference
          </Link>
        </nav>
        <div className="header__spacer" />

        {health && (
          <span className="pill" title={health.database.version ?? undefined}>
            <span className={`dot dot--${connected ? 'good' : 'critical'}`} aria-hidden="true" />
            {connected ? health.database.database : 'not connected'}
          </span>
        )}
        {health?.database.readOnlyRole && <span className="pill">read-only</span>}
        {health && !health.capabilities.whatIfIndex && (
          <span className="pill" title="Install hypopg to test indexes without building them">
            no hypopg
          </span>
        )}

        <button
          className="btn btn--ghost btn--small"
          onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
          title={`Theme: ${theme}`}
        >
          {theme === 'system' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'}
        </button>
      </header>

      <main className="main">
        {route.name === 'home' ? (
          <LandingPage health={health} />
        ) : route.name === 'queries' ? (
          <QueriesPage />
        ) : route.name === 'workload' ? (
          <WorkloadPage
            onAnalyse={(q) => {
              setSql(q);
              navigate({ name: 'analyse' });
            }}
          />
        ) : route.name === 'indexes' ? (
          <IndexesPage canProve={health?.capabilities.dropIndex ?? false} />
        ) : route.name === 'decisions' ? (
          <DecisionsPage />
        ) : route.name === 'reference' ? (
          <ReferencePage />
        ) : route.name === 'saved' ? (
          <div className="stack">
            <section className="verdict">
              <h2 className="t-title">Saved queries</h2>
              <p className="t-lead verdict__sub">
                Every run of a saved query is recorded, so its plan history builds up without
                anyone having to remember.
              </p>
            </section>
            <SavedPage onOpen={setSql} />
          </div>
        ) : route.name === 'history' ? (
          <HistoryPage fingerprint={route.fingerprint} />
        ) : (
        <div className="stack">
          <section className="composer">
            <textarea
              className="editor"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              placeholder="SELECT …"
              aria-label="SQL query"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <div className="composer__actions">
              <button className="btn btn--primary" onClick={() => void run()} disabled={running}>
                {running ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Analysing
                  </>
                ) : (
                  'Analyse'
                )}
              </button>
              <label
                className="toggle"
                title="EXPLAIN ANALYZE executes the query to collect real measurements"
              >
                <input type="checkbox" checked={measure} onChange={(e) => setMeasure(e.target.checked)} />
                Execute to measure
              </label>
              <div className="header__spacer" />
              <span className="t-small" style={{ color: 'var(--ink-muted)' }}>
                ⌘↵
              </span>
            </div>
          </section>

          {analysis && (
            <div className="toolbar">
              <input
                className="toolbar__input"
                placeholder="Name this query to keep its history…"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                aria-label="Name for the saved query"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveQuery();
                }}
              />
              <button className="btn btn--small" onClick={() => void saveQuery()} disabled={!saveName.trim()}>
                Save
              </button>

              {analysis.slug && (
                <>
                  <button
                    className="btn btn--small"
                    onClick={() => {
                      void navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
                      setSavedNotice('Link copied.');
                    }}
                  >
                    Copy link
                  </button>
                  <Link className="btn btn--small" to={{ name: 'history', fingerprint: analysis.fingerprint }}>
                    History
                  </Link>
                </>
              )}

              {savedNotice && <span className="toolbar__notice">{savedNotice}</span>}
            </div>
          )}

          {error && (
            <div className="alert rise">
              <div>{error.message}</div>
              {error.hint && <div className="alert__hint">{error.hint}</div>}
            </div>
          )}

          {!analysis && !error && (
            <div className="empty">
              <p>
                Analyse a query, then test any index against it hypothetically — you see whether
                it works before you build anything.
              </p>
            </div>
          )}

          {analysis && (
            <>
              <Verdict analysis={analysis} />

              <div>
                <div className="segmented" role="tablist" aria-label="Analysis views">
                  <Segment id="graph" tab={tab} setTab={setTab} label="Hotspots" />
                  <Segment id="findings" tab={tab} setTab={setTab} label="Findings" count={analysis.findings.length} />
                  <Segment id="rewrites" tab={tab} setTab={setTab} label="Rewrites" count={analysis.rewrites.length} />
                  <Segment
                    id="indexes"
                    tab={tab}
                    setTab={setTab}
                    label="Indexes"
                    count={analysis.indexSuggestions.length + (analysis.statisticsSuggestions?.length ?? 0)}
                  />
                  <Segment id="settings" tab={tab} setTab={setTab} label="What-if" />
                  <Segment id="sensitivity" tab={tab} setTab={setTab} label="Sensitivity" />
                  <Segment id="plan" tab={tab} setTab={setTab} label="Plan" />
                </div>

                <div style={{ marginTop: 'var(--sp-5)' }} key={tab} className="rise">
                  {tab === 'graph' && (
                    <>
                      <div className="section-label">
                        <span className="t-caption">Where the time goes</span>
                        <div className="section-label__spacer" />
                        <span className="t-small">rows flow upward · click a node</span>
                      </div>
                      <div className="group" style={{ padding: 'var(--sp-5)' }}>
                        <PlanGraph plan={analysis.plan} selectedId={selectedId} onSelect={setSelectedId} />
                      </div>
                      <div style={{ marginTop: 'var(--sp-6)' }}>
                        <div className="section-label">
                          <span className="t-caption">Slowest operations</span>
                          <div className="section-label__spacer" />
                          <span className="t-small">by self time</span>
                        </div>
                        <div className="group" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
                          <Hotspots
                            plan={analysis.plan}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {tab === 'findings' && (
                    <div className="group">
                      <Findings
                        findings={analysis.findings}
                        selectedNodeId={selectedId}
                        onSelect={setSelectedId}
                      />
                    </div>
                  )}

                  {tab === 'rewrites' && (
                    <div className="group">
                      <Rewrites
                        rewrites={analysis.rewrites}
                        sql={sql}
                        canProve={health?.capabilities.proveRewrite ?? false}
                        fingerprint={analysis.fingerprint}
                        analysisSlug={analysis.slug ?? null}
                      />
                    </div>
                  )}

                  {tab === 'indexes' && (
                    <>
                      {(analysis.statisticsSuggestions?.length ?? 0) > 0 && (
                        <div className="section-label">
                          <span className="t-caption">Index suggestions</span>
                        </div>
                      )}
                      <div className="group">
                        <Suggestions
                          suggestions={analysis.indexSuggestions}
                          sql={sql}
                          canProve={health?.capabilities.whatIfIndex ?? false}
                          fingerprint={analysis.fingerprint}
                          analysisSlug={analysis.slug ?? null}
                        />
                      </div>
                      {(analysis.statisticsSuggestions?.length ?? 0) > 0 && (
                        <div style={{ marginTop: 'var(--sp-6)' }}>
                          <div className="section-label">
                            <span className="t-caption">Extended statistics</span>
                            <div className="section-label__spacer" />
                            <span className="t-small">for correlated columns</span>
                          </div>
                          <div className="group">
                            <StatisticsAdvice
                              suggestions={analysis.statisticsSuggestions ?? []}
                              sql={sql}
                              canProve={health?.capabilities.proveStatistics ?? false}
                              sandboxDatabase={health?.sandbox?.database ?? null}
                              fingerprint={analysis.fingerprint}
                              analysisSlug={analysis.slug ?? null}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {tab === 'settings' && (
                    <div className="group">
                      <WhatIfSettings sql={sql} measure={measure} />
                    </div>
                  )}

                  {tab === 'sensitivity' && (
                    <div className="group">
                      <Sensitivity sql={sql} canRun={health?.capabilities.sensitivity ?? false} />
                    </div>
                  )}

                  {tab === 'plan' && (
                    <>
                      <div className="group">
                        <PlanTree plan={analysis.plan} selectedId={selectedId} onSelect={setSelectedId} />
                      </div>
                      <div style={{ marginTop: 'var(--sp-6)' }}>
                        <div className="section-label">
                          <span className="t-caption">Time distribution</span>
                          <div className="section-label__spacer" />
                          <span className="t-small">nesting, weighted by self time</span>
                        </div>
                        <div className="group" style={{ padding: 'var(--sp-5)' }}>
                          <FlameGraph
                            layout={analysis.flame}
                            plan={analysis.plan}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                          />
                        </div>
                      </div>
                      <div style={{ marginTop: 'var(--sp-6)' }}>
                        <div className="section-label">
                          <span className="t-caption">What happened</span>
                        </div>
                        <div className="group" style={{ padding: 'var(--sp-5)' }}>
                          <p className="t-body" style={{ color: 'var(--ink-secondary)', maxWidth: '68ch' }}>
                            {analysis.narration}
                          </p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {selectedNode && (
                <div className="rise">
                  <div className="section-label">
                    <span className="t-caption">Node detail</span>
                    <div className="section-label__spacer" />
                    <button className="btn btn--ghost btn--small" onClick={() => setSelectedId(null)}>
                      Clear
                    </button>
                  </div>
                  <div className="group" style={{ padding: 'var(--sp-5)' }}>
                    <NodeDetail node={selectedNode} plan={analysis.plan} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        )}
      </main>
    </div>
  );
}

function Segment({
  id,
  tab,
  setTab,
  label,
  count,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      className="segmented__item"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
    >
      {label}
      {count !== undefined && count > 0 && <span className="segmented__count">{count}</span>}
    </button>
  );
}

/**
 * The hero.
 *
 * One sentence, at size, saying the most important true thing about this query
 * — taken from the highest-impact finding rather than composed separately, so
 * the headline and the detail can never disagree.
 */
function Verdict({ analysis }: { analysis: Analysis }) {
  const { plan, findings } = analysis;
  const top: Finding | undefined = findings.find((f) => f.kind !== 'not-analyzed');
  const critical = findings.filter((f) => f.severity === 'critical').length;

  return (
    <section className="verdict">
      <div className="verdict__eyebrow">
        <span
          className={`dot dot--${critical > 0 ? 'critical' : top ? 'warning' : 'good'}`}
          aria-hidden="true"
        />
        <span className="t-caption">
          {critical > 0
            ? `${critical} critical ${critical === 1 ? 'issue' : 'issues'}`
            : top
              ? 'Worth a look'
              : 'Nothing to flag'}
        </span>
      </div>

      <h2 className="t-hero verdict__headline">{top ? top.title : 'This query looks healthy.'}</h2>

      <p className="t-lead verdict__sub">
        {top
          ? top.detail
          : plan.analyzed
            ? 'Estimates were close, nothing spilled to disk, and no scan is doing obviously avoidable work.'
            : 'Turn on “Execute to measure” to compare the planner’s estimates against what actually happens.'}
      </p>

      <div className="metrics">
        {plan.analyzed ? (
          <>
            <span>
              <b>{formatMs(plan.totalMs)}</b> elapsed
            </span>
            <span>
              <b>{formatMs(plan.totalWorkMs)}</b> of work
              {plan.isParallel ? ' (ran in parallel)' : ''}
            </span>
            <span>
              <b>{formatRows(plan.root.actualRowsTotal)}</b> rows returned
            </span>
            <span>
              <b>{formatMs(plan.planningTimeMs)}</b> planning
            </span>
            {top && top.impactMs > 0 && plan.totalWorkMs ? (
              <span>
                <b>{formatPercent(Math.min(top.impactMs / plan.totalWorkMs, 1))}</b> of work in the issue above
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span>
              <b>{plan.totalCost.toFixed(0)}</b> estimated cost
            </span>
            <span>
              <b>{formatRows(plan.root.estimatedRowsTotal)}</b> rows estimated
            </span>
            <span>not executed — estimates only</span>
          </>
        )}
      </div>
    </section>
  );
}
