/**
 * Extended-statistics suggestions, and the sandbox proof loop.
 *
 * Same contract as index suggestions — a suggestion is a hypothesis until
 * proven — but the proof here cannot be hypothetical: CREATE STATISTICS has no
 * HypoPG equivalent, so "Prove it" runs the real DDL inside a rolled-back
 * transaction on an explicitly configured sandbox (QUERYNOT_SANDBOX_URL).
 * Without one the button is disabled with the reason, and the DDL stands as
 * advice — mirroring the "no hypopg" treatment rather than silently breaking.
 */

import { useState } from 'react';
import { api, ApiError, type StatisticsFinding, type StatisticsProof } from '../api';
import { Proof } from './Suggestions';

type ProofState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; proof: StatisticsProof }
  | { status: 'error'; message: string; hint: string | null };

const OUTCOME_LABEL: Record<StatisticsProof['outcome'], string> = {
  'estimates-fixed': 'Estimates fixed',
  'estimates-improved': 'Estimates improved',
  'no-effect': 'No effect',
};

const OUTCOME_DOT: Record<StatisticsProof['outcome'], 'good' | 'warning' | 'muted'> = {
  'estimates-fixed': 'good',
  'estimates-improved': 'warning',
  'no-effect': 'muted',
};

const SANDBOX_HINT =
  'Point QUERYNOT_SANDBOX_URL at a disposable copy to test this without touching production';

const rows = (n: number): string => Math.round(n).toLocaleString('en-US');
const ratio = (r: number): string => `${r.toFixed(1)}x`;

interface Props {
  suggestions: StatisticsFinding[];
  sql: string;
  canProve: boolean;
  /** Which database proofs run against, for the button title. */
  sandboxDatabase: string | null;
  fingerprint: string;
  analysisSlug: string | null;
}

export function StatisticsAdvice({
  suggestions,
  sql,
  canProve,
  sandboxDatabase,
  fingerprint,
  analysisSlug,
}: Props) {
  return (
    <div>
      {suggestions.map((finding, i) => (
        <StatisticsRow
          key={`${finding.relation}-${i}`}
          finding={finding}
          sql={sql}
          canProve={canProve}
          sandboxDatabase={sandboxDatabase}
          fingerprint={fingerprint}
          analysisSlug={analysisSlug}
        />
      ))}
    </div>
  );
}

function StatisticsRow({
  finding,
  sql,
  canProve,
  sandboxDatabase,
  fingerprint,
  analysisSlug,
}: {
  finding: StatisticsFinding;
  sql: string;
  canProve: boolean;
  sandboxDatabase: string | null;
  fingerprint: string;
  analysisSlug: string | null;
}) {
  const [proof, setProof] = useState<ProofState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);

  async function prove() {
    setProof({ status: 'running' });
    try {
      const result = await api.whatIfStatistics(sql, finding.relation, finding.columns);
      setProof({ status: 'done', proof: result });

      // Record what was concluded, like the index prove flow does.
      void api
        .recordDecision({
          analysisSlug,
          fingerprint,
          kind: 'statistics',
          change: result.adviceDdl,
          verdict: result.outcome,
          headline: result.planDiff.diff.summary.headline,
          costBefore: result.planDiff.diff.summary.costBefore,
          costAfter: result.planDiff.diff.summary.costAfter,
          costOnly: false,
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

  function copy() {
    void navigator.clipboard?.writeText(finding.ddl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div className="group__row suggestion">
      <div className="suggestion__head">
        <code className="code">{finding.ddl}</code>
        <div style={{ display: 'flex', gap: 'var(--sp-2)', flexShrink: 0 }}>
          <button className="btn btn--ghost btn--small" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            className="btn btn--small"
            onClick={prove}
            disabled={!canProve || proof.status === 'running'}
            title={
              canProve
                ? `Create it in a rolled-back transaction on ${sandboxDatabase ?? 'the sandbox'}, ANALYZE, and re-measure the estimate`
                : SANDBOX_HINT
            }
          >
            {proof.status === 'running' ? (
              <>
                <span className="spinner" aria-hidden="true" /> Proving
              </>
            ) : (
              'Prove it'
            )}
          </button>
        </div>
      </div>

      <div className="suggestion__reason">
        {finding.reason}{' '}
        <span style={{ color: 'var(--ink-muted)' }}>Confidence: {finding.confidence}.</span>
      </div>

      {finding.existingAdvice && (
        <div className="caveat">
          <strong>Existing object.</strong> {finding.existingAdvice}
        </div>
      )}

      {finding.caveat && (
        <div className="caveat">
          <strong>Caveat.</strong> {finding.caveat}
        </div>
      )}

      {!canProve && proof.status === 'idle' && (
        <div className="suggestion__reason" style={{ color: 'var(--ink-muted)' }}>
          {SANDBOX_HINT}.
        </div>
      )}

      {proof.status === 'error' && (
        <div className="proof">
          <div className="proof__verdict">
            <span className="dot dot--critical" aria-hidden="true" />
            Could not test
          </div>
          <div className="proof__headline">{proof.message}</div>
          {proof.hint && <div className="proof__note">{proof.hint}</div>}
        </div>
      )}

      {proof.status === 'done' && <StatisticsProofView proof={proof.proof} />}
    </div>
  );
}

function StatisticsProofView({ proof }: { proof: StatisticsProof }) {
  const acc = proof.accuracy;
  return (
    <div className="proof">
      <div className="proof__verdict">
        <span className={`dot dot--${OUTCOME_DOT[proof.outcome]}`} aria-hidden="true" />
        {OUTCOME_LABEL[proof.outcome]}
      </div>

      {/* The estimate is the thing CREATE STATISTICS changes, so it leads;
          the cost verdict rides in the embedded plan diff below. */}
      {acc ? (
        <div className="proof__headline">
          {rows(acc.before.estimatedRows)} → {rows(acc.after.estimatedRows)} estimated against{' '}
          {rows(acc.after.actualRows)} actual on {acc.nodeLabel}; {ratio(acc.before.ratio)} →{' '}
          {ratio(acc.after.ratio)}.
        </div>
      ) : (
        <div className="proof__headline">{proof.accuracyUnavailableReason}</div>
      )}

      {proof.dependency && (
        <ul className="changes">
          {proof.dependency.pairs.map((p, i) => (
            <li key={i}>
              {p.determinant.join(', ')} determines {p.dependent} with degree {p.degree.toFixed(2)}{' '}
              (pg_stats_ext.dependencies, measured on the sandbox)
            </li>
          ))}
        </ul>
      )}

      <Proof result={proof.planDiff} hideVerdict />

      <div className="proof__note">{proof.note}</div>
    </div>
  );
}
