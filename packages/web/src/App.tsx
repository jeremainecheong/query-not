import { useEffect, useMemo, useState } from 'react';
import { formatMs, formatRows } from '@query-not/core';

import { api, ApiError, type Analysis, type Health } from './api';
import { FlameGraph } from './components/FlameGraph';
import { Findings } from './components/Findings';
import { NodeDetail, PlanTree } from './components/PlanTree';
import { Suggestions } from './components/Suggestions';

const SAMPLE = `SELECT *
FROM orders
WHERE status = 'disputed'
  AND created_at > now() - interval '30 days'`;

type Theme = 'system' | 'light' | 'dark';

export function App() {
  const [sql, setSql] = useState(SAMPLE);
  const [measure, setMeasure] = useState(true);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

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

  const selectedNode = useMemo(
    () => analysis?.plan.nodes.find((n) => n.id === selectedId) ?? null,
    [analysis, selectedId],
  );

  const connected = health?.database.connected ?? false;

  return (
    <div className="app">
      <header className="header">
        <div className="header__mark">
          query<span>-not</span>
        </div>

        <div className="header__spacer" />

        {health && (
          <span className="pill" title={health.database.version ?? undefined}>
            <span className={`dot dot--${connected ? 'good' : 'critical'}`} aria-hidden="true" />
            {connected ? health.database.database : 'not connected'}
          </span>
        )}
        {health?.database.readOnlyRole && (
          <span className="pill" title="The agent's role cannot write to this database">
            read-only
          </span>
        )}
        {health && !health.capabilities.whatIfIndex && (
          <span className="pill" title="Install hypopg to test indexes without building them">
            <span className="dot dot--muted" aria-hidden="true" />
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
        <section className="card">
          <textarea
            className="editor"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            placeholder="SELECT …"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="editor-footer">
            <button className="btn btn--primary" onClick={() => void run()} disabled={running}>
              {running ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Analysing
                </>
              ) : (
                'Analyse'
              )}
            </button>

            <label className="toggle" title="EXPLAIN ANALYZE executes the query to collect real measurements">
              <input type="checkbox" checked={measure} onChange={(e) => setMeasure(e.target.checked)} />
              Execute to measure
            </label>

            <div className="card__spacer" />
            <span className="card__sub">⌘↵ to run</span>
          </div>
        </section>

        {error && (
          <div className="alert">
            <div>{error.message}</div>
            {error.hint && <div className="alert__hint">{error.hint}</div>}
          </div>
        )}

        {!analysis && !error && (
          <div className="card">
            <div className="empty">
              Paste a query and analyse it. Every index suggestion can then be tested against a
              hypothetical index — so you see whether it works before you build anything.
            </div>
          </div>
        )}

        {analysis && (
          <>
            <Summary analysis={analysis} />

            <section className="card">
              <div className="card__header">
                <span className="card__title">What happened</span>
                <div className="card__spacer" />
                <span className="card__sub">plain English</span>
              </div>
              <div className="card__body">
                <p className="narration">{analysis.narration}</p>
              </div>
            </section>

            <section className="card">
              <div className="card__header">
                <span className="card__title">Findings</span>
                <div className="card__spacer" />
                <span className="card__sub">
                  {analysis.findings.length} — ranked by time cost
                </span>
              </div>
              <Findings
                findings={analysis.findings}
                selectedNodeId={selectedId}
                onSelect={setSelectedId}
              />
            </section>

            <section className="card">
              <div className="card__header">
                <span className="card__title">Where the time went</span>
                <div className="card__spacer" />
                <span className="card__sub">click a node for detail</span>
              </div>
              <div className="card__body">
                <FlameGraph
                  layout={analysis.flame}
                  plan={analysis.plan}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </div>
            </section>

            <section className="card">
              <div className="card__header">
                <span className="card__title">Index suggestions</span>
                <div className="card__spacer" />
                <span className="card__sub">hypotheses — test before you trust</span>
              </div>
              <Suggestions
                suggestions={analysis.indexSuggestions}
                sql={sql}
                canProve={health?.capabilities.whatIfIndex ?? false}
              />
            </section>

            <section className="card">
              <div className="card__header">
                <span className="card__title">Plan</span>
                <div className="card__spacer" />
                <span className="card__sub">
                  {analysis.plan.nodes.length} nodes · totals, not per-loop
                </span>
              </div>
              <PlanTree plan={analysis.plan} selectedId={selectedId} onSelect={setSelectedId} />
            </section>

            {selectedNode && (
              <section className="card">
                <div className="card__header">
                  <span className="card__title">Node detail</span>
                  <div className="card__spacer" />
                  <button className="btn btn--ghost btn--small" onClick={() => setSelectedId(null)}>
                    Clear
                  </button>
                </div>
                <div className="card__body">
                  <NodeDetail node={selectedNode} plan={analysis.plan} />
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Summary({ analysis }: { analysis: Analysis }) {
  const { plan } = analysis;

  return (
    <div className="stats">
      {plan.analyzed ? (
        <>
          <Stat label="Elapsed" value={formatMs(plan.totalMs)} note="wall clock" />
          <Stat
            label="Work done"
            value={formatMs(plan.totalWorkMs)}
            note={plan.isParallel ? 'exceeds elapsed — ran in parallel' : 'across all nodes'}
          />
          <Stat label="Rows" value={formatRows(plan.root.actualRowsTotal)} note="returned" />
          <Stat label="Planning" value={formatMs(plan.planningTimeMs)} note="before execution" />
        </>
      ) : (
        <>
          <Stat label="Estimated cost" value={plan.totalCost.toFixed(0)} note="planner units" />
          <Stat label="Rows" value={formatRows(plan.root.estimatedRowsTotal)} note="estimated" />
          <Stat label="Planning" value={formatMs(plan.planningTimeMs)} note="—" />
          <Stat label="Measured" value="No" note="enable Execute to measure" />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      <div className="stat__note">{note}</div>
    </div>
  );
}
