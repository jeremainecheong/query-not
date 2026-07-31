/**
 * What was tested, what it concluded, and whether it ever shipped.
 *
 * The reasoning behind an index is normally lost the moment the person who
 * tested it moves on — six months later the index is there and nobody knows
 * why, or it is not there and nobody knows whether it was tried. This is the
 * record.
 *
 * The "applied" toggle is the part that matters. A proven suggestion nobody
 * shipped is a different thing from one that shipped, and only a human knows
 * which — so it is a checkbox, not an inference.
 */

import { useEffect, useState } from 'react';

import { api, type Decision } from '../api';
import { Link } from '../router';
import { relative } from './SavedPage';

// Every verdict vocabulary that reaches the store: index/settings what-ifs,
// generated-rewrite outcomes, drop proofs, statistics proofs. An unknown
// verdict shows its raw value rather than borrowing a label — mislabelling a
// result is worse than looking unpolished.
const VERDICT_STYLE: Record<string, { label: string; dot: 'good' | 'critical' | 'muted' }> = {
  improved: { label: 'Proven', dot: 'good' },
  regressed: { label: 'Made it worse', dot: 'critical' },
  unchanged: { label: 'No change', dot: 'muted' },
  proven: { label: 'Proven', dot: 'good' },
  'improved-unverified': { label: 'Improved, rows unverified', dot: 'muted' },
  'no-effect': { label: 'No effect', dot: 'muted' },
  differed: { label: 'Returns different rows', dot: 'critical' },
  'advice-only': { label: 'Not executed', dot: 'muted' },
  // "No plan changed" bounded to the tested queries, matching the indexes
  // page — never an unbounded green "safe to drop" on the decisions list.
  'no-plan-changed': { label: 'No plan changed', dot: 'good' },
  'plans-changed-not-worse': { label: 'Plans changed, none worse', dot: 'muted' },
  'estimates-fixed': { label: 'Estimates fixed', dot: 'good' },
  'estimates-improved': { label: 'Estimates improved', dot: 'good' },
};

export function DecisionsPage() {
  const [decisions, setDecisions] = useState<Decision[] | null>(null);

  async function load() {
    setDecisions((await api.listDecisions().catch(() => ({ decisions: [] }))).decisions);
  }

  useEffect(() => {
    void load();
  }, []);

  /**
   * Flip locally first, then persist.
   *
   * Waiting for the round trip before re-rendering makes the checkbox look
   * broken — you click it and nothing happens until the request lands. On
   * failure it reverts, so the UI never claims something was saved when it
   * was not.
   */
  async function toggleApplied(decision: Decision, applied: boolean) {
    setDecisions((current) =>
      (current ?? []).map((d) => (d.id === decision.id ? { ...d, applied } : d)),
    );
    try {
      await api.markApplied(decision.id, applied);
    } catch {
      setDecisions((current) =>
        (current ?? []).map((d) => (d.id === decision.id ? { ...d, applied: !applied } : d)),
      );
    }
  }

  if (!decisions) return <div className="empty"><p>Loading…</p></div>;

  if (decisions.length === 0) {
    return (
      <div className="stack stack--tight">
        <section className="verdict">
          <h2 className="t-title">Decisions</h2>
          <p className="t-lead verdict__sub">
            Nothing recorded yet. When you prove an index or a setting change, the result is
            kept here — the DDL, the verdict, and whether it was ever actually shipped.
          </p>
        </section>
      </div>
    );
  }

  const applied = decisions.filter((d) => d.applied).length;
  // "Proven" spans vocabularies: an improved what-if, a proven rewrite, a
  // safe-to-drop index and fixed estimates are all positive verdicts.
  const proven = decisions.filter((d) => VERDICT_STYLE[d.verdict]?.dot === 'good').length;

  return (
    <div className="stack stack--tight">
      <section className="verdict">
        <div className="verdict__eyebrow">
          <span className="dot dot--good" aria-hidden="true" />
          <span className="t-caption">
            {proven} proven · {applied} shipped
          </span>
        </div>
        <h2 className="t-title">Decisions</h2>
        <p className="t-lead verdict__sub">
          Every change that was tested against a real plan, and what it concluded. The
          reasoning survives the person who did the testing.
        </p>
      </section>

      <div className="group">
        {decisions.map((d) => {
          const style = VERDICT_STYLE[d.verdict] ?? { label: d.verdict, dot: 'muted' as const };
          return (
          <div className="group__row decision-row" key={d.id}>
            <div className="decision-row__main">
              <div className="decision-row__head">
                <span className={`dot dot--${style.dot}`} aria-hidden="true" />
                <span className="decision-row__verdict">{style.label}</span>
                <span className="pill">{d.kind}</span>
                <span className="t-small">{relative(d.createdAt)}</span>
              </div>

              <code className="code decision-row__change">{d.change}</code>

              {d.headline && <p className="decision-row__headline">{d.headline}</p>}

              <div className="finding__evidence">
                {d.costBefore !== null && d.costAfter !== null && (
                  <span className="chip">
                    cost <b>{d.costBefore.toFixed(0)} → {d.costAfter.toFixed(0)}</b>
                  </span>
                )}
                {d.costOnly && <span className="chip">estimate only</span>}
                {d.analysisSlug && (
                  <Link className="chip" to={{ name: 'analysis', slug: d.analysisSlug }}>
                    open the analysis
                  </Link>
                )}
                <Link className="chip" to={{ name: 'history', fingerprint: d.fingerprint }}>
                  plan history
                </Link>
              </div>
            </div>

            <div className="decision-row__actions">
              <label className="toggle" title="Whether this change was actually applied in production">
                <input
                  type="checkbox"
                  checked={d.applied}
                  onChange={(e) => void toggleApplied(d, e.target.checked)}
                />
                Shipped
              </label>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
