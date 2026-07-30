/**
 * The findings list.
 *
 * Severity is never carried by colour alone — every row pairs its status colour
 * with a glyph and the severity word, per the status-palette rule.
 */

import type { Finding, Severity } from '@query-not/core';

const GLYPH: Record<Severity, string> = { critical: '!', warning: '!', info: 'i' };
const WORD: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Note' };

interface Props {
  findings: Finding[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string | null) => void;
}

export function Findings({ findings, selectedNodeId, onSelect }: Props) {
  if (findings.length === 0) {
    return (
      <div className="empty">
        Nothing to flag. Estimates were close, nothing spilled, and no scan was doing
        obviously avoidable work.
      </div>
    );
  }

  return (
    <div>
      {findings.map((finding, i) => (
        <div
          key={`${finding.kind}-${finding.nodeId ?? 'plan'}-${i}`}
          className={`finding${finding.nodeId && finding.nodeId === selectedNodeId ? ' finding--selected' : ''}`}
          onClick={() => onSelect(finding.nodeId)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(finding.nodeId);
            }
          }}
        >
          <div
            className={`finding__icon finding__icon--${finding.severity}`}
            aria-hidden="true"
          >
            {GLYPH[finding.severity]}
          </div>
          <div>
            <div className="finding__title">
              <span className="sr-only">{WORD[finding.severity]}: </span>
              {finding.title}
            </div>
            <div className="finding__detail">{finding.detail}</div>

            {finding.suggestion && <div className="finding__suggestion">{finding.suggestion}</div>}

            {Object.keys(finding.evidence).length > 0 && (
              <div className="finding__evidence">
                {Object.entries(finding.evidence)
                  .filter(([, v]) => String(v).length > 0 && String(v).length < 90)
                  .map(([k, v]) => (
                    <span className="chip" key={k}>
                      {humanise(k)} <b>{String(v)}</b>
                    </span>
                  ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}
