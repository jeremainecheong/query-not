/**
 * The index inventory, and the drop-safety proof loop.
 *
 * The listing never says "safe". idx_scan = 0 is evidence with well-known blind
 * spots — resets, replicas, constraint enforcement — and every row's sentence
 * says so. The verdict comes from "Prove drop": hide the index with hypopg
 * 1.4's hypopg_hide_index, re-plan every query the agent knows about, and diff.
 * Even then the claim is bounded to those enumerated queries, because that is
 * the only honest claim a tool that cannot see every client can make.
 *
 * Indexes that enforce semantics — primary keys, unique and exclusion
 * constraints, replica identities, FK-referenced — get no button at all:
 * dropping them is a schema change, and no plan diff can bless it.
 */

import { useEffect, useState } from 'react';

import { api, ApiError, type DropIndexProof, type DropOutcome, type IndexInventory, type IndexInventoryEntry } from '../api';
import { relative } from './SavedPage';

type ProofState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: DropIndexProof }
  | { status: 'error'; message: string; hint: string | null };

const OUTCOME: Record<DropOutcome, { label: string; dot: 'good' | 'muted' | 'critical' }> = {
  'no-plan-changed': { label: 'No plan changed', dot: 'good' },
  'plans-changed-not-worse': { label: 'Plans changed, none worse', dot: 'muted' },
  regressed: { label: 'Load-bearing — do not drop', dot: 'critical' },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function IndexesPage({ canProve }: { canProve: boolean }) {
  const [inventory, setInventory] = useState<IndexInventory | null>(null);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  useEffect(() => {
    api
      .indexes()
      .then(setInventory)
      .catch((err) => {
        setError({
          message: err instanceof Error ? err.message : String(err),
          hint: err instanceof ApiError ? err.hint : null,
        });
      });
  }, []);

  if (error) {
    return (
      <div className="alert">
        <div>{error.message}</div>
        {error.hint && <div className="alert__hint">{error.hint}</div>}
      </div>
    );
  }

  if (!inventory) return <div className="empty"><p>Loading…</p></div>;

  const candidates = inventory.indexes.filter((i) => i.droppableForPerformance);
  const enforcing = inventory.indexes.filter((i) => !i.droppableForPerformance);

  return (
    <div className="stack stack--tight">
      <section className="verdict">
        <div className="verdict__eyebrow">
          <span className="dot dot--good" aria-hidden="true" />
          <span className="t-caption">
            {candidates.length} drop candidate{candidates.length === 1 ? '' : 's'} · {enforcing.length} enforcing semantics
          </span>
        </div>
        <h2 className="t-title">Indexes</h2>
        <p className="t-lead verdict__sub">{inventory.statsNote}</p>
        {inventory.statsResetAt && (
          <div className="metrics">
            <span>
              statistics last reset <b>{relative(inventory.statsResetAt)}</b>
            </span>
          </div>
        )}
      </section>

      <div>
        <div className="section-label">
          <span className="t-caption">Drop candidates</span>
          <div className="section-label__spacer" />
          <span className="t-small">fewest scans first, then largest — proof before drop</span>
        </div>
        <div className="group">
          {candidates.length === 0 ? (
            <div className="empty">
              <p>Every index here backs a constraint or a replica identity — nothing to drop for performance.</p>
            </div>
          ) : (
            candidates.map((entry) => (
              <CandidateRow key={`${entry.schema}.${entry.index}`} entry={entry} canProve={canProve} />
            ))
          )}
        </div>
      </div>

      {enforcing.length > 0 && (
        <div>
          <div className="section-label">
            <span className="t-caption">Not droppable for performance</span>
            <div className="section-label__spacer" />
            <span className="t-small">these enforce semantics — dropping them is a schema change</span>
          </div>
          <div className="group">
            {enforcing.map((entry) => (
              <div className="group__row indexrow" key={`${entry.schema}.${entry.index}`}>
                <div className="indexrow__head">
                  <span className="indexrow__name">{entry.index}</span>
                  <span className="t-small">on {entry.schema}.{entry.table}</span>
                  {entry.disqualifiers.map((d) => (
                    <span className="pill" key={d.kind + d.evidence}>{d.kind}</span>
                  ))}
                </div>
                <code className="code indexrow__def">{entry.definition}</code>
                {entry.disqualifiers.map((d, i) => (
                  <p className="indexrow__evidence" key={i}>{d.evidence}</p>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateRow({ entry, canProve }: { entry: IndexInventoryEntry; canProve: boolean }) {
  const [proof, setProof] = useState<ProofState>({ status: 'idle' });

  async function prove() {
    setProof({ status: 'running' });
    try {
      const result = await api.whatIfDropIndex(entry.index, entry.schema);
      setProof({ status: 'done', result });

      // Record the conclusion, like the index and rewrite proofs do — a
      // decisions page that only fills when someone presses an extra button
      // never fills. The fingerprint is the qualified index name: that is the
      // decision's identity, there being no single query behind it.
      const worst = result.perQuery
        .filter((q) => q.verdict === 'regressed')
        .sort((a, b) => (b.costChange ?? 0) - (a.costChange ?? 0))[0];
      void api
        .recordDecision({
          analysisSlug: null,
          fingerprint: `${result.index.schema}.${result.index.name}`,
          kind: 'drop-index',
          change: `DROP INDEX "${result.index.schema}"."${result.index.name}";`,
          verdict: result.outcome,
          headline: result.note,
          costBefore: worst?.costBefore ?? null,
          costAfter: worst?.costAfter ?? null,
          costOnly: true,
        })
        .catch(() => undefined);
    } catch (err) {
      setProof({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        hint: err instanceof ApiError ? err.hint : null,
      });
    }
  }

  return (
    <div className="group__row indexrow">
      <div className="indexrow__head">
        <span className="indexrow__name">{entry.index}</span>
        <span className="t-small">on {entry.schema}.{entry.table}</span>
        {!entry.valid && <span className="pill">invalid</span>}
        <div className="section-label__spacer" />
        <button
          className="btn btn--small"
          onClick={() => void prove()}
          disabled={!canProve || proof.status === 'running'}
          title={
            canProve
              ? 'Hide this index with hypopg and re-plan every query the agent knows about'
              : 'Requires hypopg 1.4.0 (hypopg_hide_index) on the target database'
          }
        >
          {proof.status === 'running' ? (
            <>
              <span className="spinner" aria-hidden="true" /> Proving
            </>
          ) : (
            'Prove drop'
          )}
        </button>
      </div>

      <code className="code indexrow__def">{entry.definition}</code>

      <div className="indexrow__meta">
        <span><b>{formatBytes(entry.sizeBytes)}</b></span>
        <span>·</span>
        <span><b>{entry.scans}</b> scan{entry.scans === 1 ? '' : 's'}</span>
        {entry.lastScanAt && (
          <>
            <span>·</span>
            <span>last scanned {relative(entry.lastScanAt)}</span>
          </>
        )}
      </div>

      <p className="indexrow__evidence">{entry.evidence}</p>

      {!canProve && proof.status === 'idle' && (
        <p className="indexrow__evidence" style={{ color: 'var(--ink-muted)' }}>
          Install hypopg 1.4+ to prove a drop without dropping anything.
        </p>
      )}

      {proof.status === 'error' && (
        <div className="proof">
          <div className="proof__verdict">
            <span className="dot dot--critical" aria-hidden="true" />
            Could not prove
          </div>
          <div className="proof__headline">{proof.message}</div>
          {proof.hint && <div className="proof__note">{proof.hint}</div>}
        </div>
      )}

      {proof.status === 'done' && <DropProof result={proof.result} />}
    </div>
  );
}

function DropProof({ result }: { result: DropIndexProof }) {
  const [showSkipped, setShowSkipped] = useState(false);
  const outcome = OUTCOME[result.outcome];

  return (
    <div className="proof">
      <div className="proof__verdict">
        <span className={`dot dot--${outcome.dot}`} aria-hidden="true" />
        {outcome.label}
      </div>

      <div className="proof__headline">{result.note}</div>

      <div className="finding__evidence">
        <span className="chip">
          tested <b>{result.coverage.tested}</b> known {result.coverage.tested === 1 ? 'query' : 'queries'} —{' '}
          {result.coverage.fromStore} from history, {result.coverage.fromWorkload} from workload
        </span>
        {result.coverage.capped && <span className="chip">capped at {result.coverage.cap}</span>}
        <span className="chip">estimate only</span>
      </div>

      {result.coverage.skipped.length > 0 && (
        <div className="diff">
          <button
            className="btn btn--ghost btn--small diff__toggle"
            onClick={() => setShowSkipped(!showSkipped)}
          >
            {showSkipped ? '▾' : '▸'} {result.coverage.skipped.length} skipped — why
          </button>
          {showSkipped && (
            <ul className="changes">
              {result.coverage.skipped.map((s, i) => (
                <li key={i}>{s.source}: {s.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="dropproof__queries">
        {result.perQuery.map((q, i) => (
          <div className="dropproof__query" key={`${q.fingerprint}-${i}`}>
            <span
              className={`dot dot--${
                q.error ? 'warning' : q.verdict === 'regressed' ? 'critical' : q.verdict === 'unchanged' ? 'muted' : 'good'
              }`}
              aria-hidden="true"
            />
            <div className="dropproof__query-main">
              <code className="code">{q.sql}</code>
              {q.error ? (
                <p className="indexrow__evidence">Could not plan: {q.error}</p>
              ) : (
                q.headline && <p className="indexrow__evidence">{q.headline}</p>
              )}
              {q.accessChanges.length > 0 && (
                <ul className="changes">
                  {q.accessChanges.slice(0, 4).map((change, j) => (
                    <li key={j}>{change}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
