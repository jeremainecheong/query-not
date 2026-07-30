/**
 * Rewrite advice from the SQL's AST.
 *
 * The design rule here: a rewrite that changes *results* must never look like
 * a rewrite that only changes *speed*. `NOT IN` → `NOT EXISTS` is the classic —
 * it is usually the right fix and it can change your result set, so the
 * semantic warning gets its own visually distinct block rather than a clause
 * buried in the suggestion text.
 */

import type { RewriteFinding, RewriteSeverity } from '../api';

const GLYPH: Record<RewriteSeverity, string> = { critical: '!', warning: '!', info: 'i' };
const WORD: Record<RewriteSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Note' };

export function Rewrites({ rewrites }: { rewrites: RewriteFinding[] }) {
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
        <div className="group__row finding" key={`${rewrite.kind}-${i}`}>
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
          </div>
        </div>
      ))}
    </div>
  );
}
