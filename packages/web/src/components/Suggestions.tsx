/**
 * Index suggestions, and the proof loop.
 *
 * A suggestion here is a *hypothesis* — columns pulled out of predicate text by
 * heuristic. "Prove it" builds the index hypothetically and re-plans, so a wrong
 * guess shows up as a plan that did not change rather than as advice someone
 * acts on. That is the entire argument for this product, so the UI never shows a
 * suggestion as settled until it has been tested.
 */

import { useState } from 'react';
import type { IndexSuggestion } from '@query-not/core';
import { api, ApiError, type WhatIfResult } from '../api';

type ProofState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: WhatIfResult }
  | { status: 'error'; message: string; hint: string | null };

interface Props {
  suggestions: IndexSuggestion[];
  sql: string;
  canProve: boolean;
  fingerprint: string;
  analysisSlug: string | null;
}

export function Suggestions({ suggestions, sql, canProve, fingerprint, analysisSlug }: Props) {
  if (suggestions.length === 0) {
    return (
      <div className="empty">
        No index suggestions. Either the scans are already using indexes, or the filters
        aren’t selective enough for one to help.
      </div>
    );
  }

  return (
    <div>
      {suggestions.map((suggestion, i) => (
        <SuggestionRow
          key={`${suggestion.relation}-${i}`}
          suggestion={suggestion}
          sql={sql}
          canProve={canProve}
          fingerprint={fingerprint}
          analysisSlug={analysisSlug}
        />
      ))}
    </div>
  );
}

function SuggestionRow({
  suggestion,
  sql,
  canProve,
  fingerprint,
  analysisSlug,
}: {
  suggestion: IndexSuggestion;
  sql: string;
  canProve: boolean;
  fingerprint: string;
  analysisSlug: string | null;
}) {
  const [proof, setProof] = useState<ProofState>({ status: 'idle' });

  async function prove() {
    setProof({ status: 'running' });
    try {
      // CONCURRENTLY belongs on the real index someone runs later, not on the
      // hypothetical one — nothing is being built here.
      const ddl = suggestion.ddl.replace(/\s+CONCURRENTLY\b/i, '');
      const result = await api.whatIfIndex(sql, ddl);
      setProof({ status: 'done', result });

      // Record what was tested. Without this the decisions page only ever fills
      // up if someone remembers to press an extra button, which nobody does.
      void api
        .recordDecision({
          analysisSlug,
          fingerprint,
          kind: 'index',
          change: suggestion.ddl,
          verdict: result.diff.summary.verdict,
          headline: result.diff.summary.headline,
          costBefore: result.diff.summary.costBefore,
          costAfter: result.diff.summary.costAfter,
          costOnly: result.costOnly,
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
    <div className="group__row suggestion">
      <div className="suggestion__head">
        <code className="code">{suggestion.ddl}</code>
        <button
          className="btn btn--small"
          onClick={prove}
          disabled={!canProve || proof.status === 'running'}
          title={
            canProve
              ? 'Create this index hypothetically and re-plan the query'
              : 'Requires the hypopg extension on the target database'
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

      <div className="suggestion__reason">
        {suggestion.reason}{' '}
        <span style={{ color: 'var(--ink-muted)' }}>Confidence: {suggestion.confidence}.</span>
      </div>

      {suggestion.caveat && (
        <div className="caveat">
          <strong>Caveat.</strong> {suggestion.caveat}
        </div>
      )}

      {!canProve && proof.status === 'idle' && (
        <div className="suggestion__reason" style={{ color: 'var(--ink-muted)' }}>
          Install the hypopg extension to test this without building it.
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

      {proof.status === 'done' && <Proof result={proof.result} />}
    </div>
  );
}

export function Proof({ result }: { result: WhatIfResult }) {
  const { summary } = result.diff;
  const improved = summary.verdict === 'improved';
  const regressed = summary.verdict === 'regressed';

  const worst = Math.max(summary.costBefore, summary.costAfter, 1);
  const beforePct = (summary.costBefore / worst) * 100;
  const afterPct = (summary.costAfter / worst) * 100;

  return (
    <div className="proof">
      <div className="proof__verdict">
        <span
          className={`dot dot--${improved ? 'good' : regressed ? 'critical' : 'muted'}`}
          aria-hidden="true"
        />
        {improved ? 'Proven' : regressed ? 'Made it worse' : 'No effect'}
      </div>

      <div className="proof__headline">{summary.headline}</div>

      <div className="compare">
        <div className="compare__bar">
          <div className="compare__label">
            <span>Before</span>
            <span>{summary.costBefore.toFixed(0)}</span>
          </div>
          <div className="compare__track">
            <div className="compare__fill" style={{ width: `${beforePct}%`, background: 'var(--ink-muted)' }} />
          </div>
        </div>
        <div className="compare__bar">
          <div className="compare__label">
            <span>After</span>
            <span>{summary.costAfter.toFixed(0)}</span>
          </div>
          <div className="compare__track">
            <div
              className="compare__fill"
              style={{
                width: `${afterPct}%`,
                background: improved ? 'var(--status-good)' : regressed ? 'var(--status-critical)' : 'var(--ink-muted)',
              }}
            />
          </div>
        </div>
      </div>

      {summary.accessChanges.length > 0 && (
        <ul className="changes">
          {summary.accessChanges.slice(0, 4).map((change, i) => (
            <li key={i}>{change}</li>
          ))}
        </ul>
      )}

      <PlanDiffView diff={result.diff} />

      {result.note && <div className="proof__note">{result.note}</div>}
    </div>
  );
}

/**
 * Node-by-node plan diff.
 *
 * Collapsed by default: the verdict and the access-method change answer "did it
 * work", and this answers "what exactly changed" for the person who does not
 * take the headline on trust. Unchanged nodes are hidden — a diff that shows
 * everything shows nothing.
 */
function PlanDiffView({ diff }: { diff: WhatIfResult['diff'] }) {
  const [open, setOpen] = useState(false);
  const changed = diff.nodes.filter((n) => n.status !== 'unchanged');

  if (changed.length === 0) return null;

  return (
    <div className="diff">
      <button className="btn btn--ghost btn--small diff__toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {changed.length} node{changed.length === 1 ? '' : 's'} changed
      </button>

      {open && (
        <div className="diff__body">
          {changed.map((node, i) => (
            <div className="diff__row" key={`${node.beforeId ?? ''}-${node.afterId ?? ''}-${i}`}>
              <span className={`diff__badge diff__badge--${node.status}`}>
                {node.status === 'added' ? '+' : node.status === 'removed' ? '−' : '~'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="diff__label" style={{ paddingLeft: node.depth * 12 }}>
                  {node.label}
                </div>
                <ul className="changes">
                  {node.changes.map((change, j) => (
                    <li key={j}>{change}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
