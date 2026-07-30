/**
 * Rewrite advice from the SQL's AST — and, for the three generated kinds, the
 * optimised statement itself with a proof loop behind it.
 *
 * Two design rules hold this together:
 *
 *   1. A rewrite that changes *results* must never look like one that only
 *      changes *speed*. The semantic warning keeps its own block.
 *   2. A generated statement is a draft until it is proven. The proof panel
 *      shows the precondition evidence (the schema facts that make the rewrite
 *      safe), the plan diff, and the row comparison — and when any of those
 *      could not be established, it says exactly which and why.
 */

import { useState } from 'react';
import { api, ApiError, type RewriteFinding, type RewriteProof, type RewriteSeverity } from '../api';
import { Proof } from './Suggestions';

const GLYPH: Record<RewriteSeverity, string> = { critical: '!', warning: '!', info: 'i' };
const WORD: Record<RewriteSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Note' };

const OUTCOME_LABEL: Record<RewriteProof['outcome'], string> = {
  proven: 'Proven',
  'improved-unverified': 'Improved, rows unverified',
  'no-effect': 'No effect',
  regressed: 'Made it worse',
  differed: 'Returns different rows',
  'advice-only': 'Not executed',
};

const OUTCOME_DOT: Record<RewriteProof['outcome'], 'good' | 'critical' | 'muted' | 'warning'> = {
  proven: 'good',
  'improved-unverified': 'warning',
  'no-effect': 'muted',
  regressed: 'critical',
  differed: 'critical',
  'advice-only': 'muted',
};

interface Props {
  rewrites: RewriteFinding[];
  sql: string;
  canProve: boolean;
  fingerprint: string;
  analysisSlug: string | null;
}

export function Rewrites({ rewrites, sql, canProve, fingerprint, analysisSlug }: Props) {
  if (rewrites.length === 0) {
    return (
      <div className="empty">
        No structural problems in the SQL itself. This checks the query text — function-wrapped
        columns, <code>NOT IN</code> null semantics, deep <code>OFFSET</code>, leading wildcards
        — independently of how it happened to run.
      </div>
    );
  }

  return (
    <div>
      {rewrites.map((rewrite, i) => (
        <RewriteRow
          key={`${rewrite.kind}-${i}`}
          rewrite={rewrite}
          sql={sql}
          canProve={canProve}
          fingerprint={fingerprint}
          analysisSlug={analysisSlug}
        />
      ))}
    </div>
  );
}

type ProofState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; proof: RewriteProof }
  | { status: 'error'; message: string; hint: string | null };

function RewriteRow({
  rewrite,
  sql,
  canProve,
  fingerprint,
  analysisSlug,
}: {
  rewrite: RewriteFinding;
  sql: string;
  canProve: boolean;
  fingerprint: string;
  analysisSlug: string | null;
}) {
  const [proof, setProof] = useState<ProofState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const candidate = rewrite.candidate ?? null;

  async function prove() {
    setProof({ status: 'running' });
    try {
      const result = await api.whatIfRewrite(sql, rewrite.kind, rewrite.location ?? null);
      setProof({ status: 'done', proof: result });

      // Record what was concluded, like the index prove flow does — a decisions
      // page that only fills up when someone presses an extra button never
      // fills up.
      void api
        .recordDecision({
          analysisSlug,
          fingerprint,
          kind: 'rewrite',
          change: result.candidate.sql,
          verdict: result.outcome,
          headline: result.note,
          costBefore: result.planDiff?.diff.summary.costBefore ?? null,
          costAfter: result.planDiff?.diff.summary.costAfter ?? null,
          costOnly: result.planDiff?.costOnly ?? true,
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
    if (!candidate) return;
    void navigator.clipboard?.writeText(candidate.sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div className="group__row finding">
      <div className={`finding__icon finding__icon--${rewrite.severity}`} aria-hidden="true">
        {GLYPH[rewrite.severity]}
      </div>
      <div>
        <div className="finding__title">
          <span className="sr-only">{WORD[rewrite.severity]}: </span>
          {rewrite.title}
        </div>
        <div className="finding__detail">{rewrite.detail}</div>

        {rewrite.snippet && (
          <div className="code" style={{ marginTop: 'var(--sp-2)' }}>
            {rewrite.snippet}
          </div>
        )}

        <div className="finding__suggestion">{rewrite.suggestion}</div>

        {rewrite.semanticChange && (
          <div className="caveat">
            <strong>Changes results, not just speed.</strong> {rewrite.semanticChange}
          </div>
        )}

        {candidate && (
          <div className="suggestion" style={{ marginTop: 'var(--sp-3)' }}>
            <div className="suggestion__head">
              <code className="code code--candidate">{candidate.sql}</code>
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
                      ? 'Check the schema facts, re-plan both forms, and compare the rows they return'
                      : 'Requires a database connection'
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
            <div className="suggestion__reason">{candidate.rationale}</div>

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

            {proof.status === 'done' && <RewriteProofView proof={proof.proof} />}
          </div>
        )}

        {!candidate && rewrite.candidateBlocked && (
          <div className="finding__suggestion" style={{ color: 'var(--ink-muted)' }}>
            No generated rewrite: {rewrite.candidateBlocked}.
          </div>
        )}
      </div>
    </div>
  );
}

const capitalise = (s: string): string =>
  s.length > 0 ? `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : s;

function RewriteProofView({ proof }: { proof: RewriteProof }) {
  return (
    <div className="proof">
      <div className="proof__verdict">
        <span className={`dot dot--${OUTCOME_DOT[proof.outcome]}`} aria-hidden="true" />
        {OUTCOME_LABEL[proof.outcome]}
      </div>

      {/* The schema facts, each with its verdict — this list is the argument,
          the row comparison below is only the backstop. */}
      <ul className="changes preconditions">
        {proof.preconditions.map((p, i) => (
          <li key={i}>
            <span className={`dot dot--${p.established ? 'good' : 'critical'}`} aria-hidden="true" />{' '}
            {p.evidence}
          </li>
        ))}
      </ul>

      {proof.planDiff && <Proof result={proof.planDiff} hideVerdict />}

      {proof.equivalence && <div className="proof__note">{capitalise(proof.equivalence.note)}</div>}

      {/* The composed note repeats what the pieces above already show; it earns
          its place only when nothing was executed and it is all there is. */}
      {!proof.planDiff && <div className="proof__note proof__note--outcome">{proof.note}</div>}
    </div>
  );
}
