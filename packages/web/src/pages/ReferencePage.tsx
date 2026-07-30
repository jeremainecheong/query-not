/**
 * The operation reference.
 *
 * Every node type Postgres can put in a plan, what it does, why the planner
 * picks it, and what goes wrong — each with a diagram in a shared visual
 * language so they can be compared rather than read one at a time.
 *
 * Rendered from `NODE_TYPES` in core, which is the same source the narrator
 * reads when explaining a real plan. Two copies would drift, and a reference
 * that disagrees with the explanation shown beside an actual query is worse
 * than no reference.
 */

import { useMemo, useState } from 'react';
import { NODE_FAMILIES, NODE_TYPES, type NodeFamily } from '@query-not/core';

import { ScanDiagram, isAliasedDiagram } from '../components/ScanDiagram';

export function ReferencePage() {
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<NodeFamily | 'all'>('all');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return NODE_TYPES.filter((entry) => {
      if (family !== 'all' && entry.family !== family) return false;
      if (!needle) return true;
      return (
        entry.nodeType.toLowerCase().includes(needle) ||
        entry.what.toLowerCase().includes(needle) ||
        entry.why.toLowerCase().includes(needle) ||
        (entry.watch ?? '').toLowerCase().includes(needle)
      );
    });
  }, [query, family]);

  const groups = NODE_FAMILIES.map((f) => ({
    ...f,
    entries: matches.filter((e) => e.family === f.id),
  })).filter((g) => g.entries.length > 0);

  return (
    <div className="stack stack--tight">
      <section className="verdict">
        <h2 className="t-title">Plan operations</h2>
        <p className="t-lead verdict__sub">
          Every operation Postgres can put in a plan — what it does, why the planner picks
          it, and how it goes wrong. The same explanations appear beside your own plans.
        </p>
      </section>

      <div className="ref-controls">
        <input
          className="toolbar__input"
          placeholder="Search operations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search plan operations"
        />
        <div className="segmented" role="tablist" aria-label="Filter by family">
          <button
            className="segmented__item"
            role="tab"
            aria-selected={family === 'all'}
            onClick={() => setFamily('all')}
          >
            All
            <span className="segmented__count">{NODE_TYPES.length}</span>
          </button>
          {NODE_FAMILIES.map((f) => (
            <button
              key={f.id}
              className="segmented__item"
              role="tab"
              aria-selected={family === f.id}
              onClick={() => setFamily(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <div className="empty">
          <p>Nothing matches “{query}”.</p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.id}>
          <div className="section-label">
            <span className="t-caption">{group.label}</span>
            <div className="section-label__spacer" />
            <span className="t-small">{group.blurb}</span>
          </div>

          <div className="ref-grid">
            {group.entries.map((entry) => {
              const borrowed = isAliasedDiagram(entry.nodeType);
              return (
                <article className="ref-card" key={entry.nodeType} id={slug(entry.nodeType)}>
                  <div className="ref-card__diagram">
                    <ScanDiagram nodeType={entry.nodeType} />
                  </div>

                  <div className="ref-card__body">
                    <h3 className="ref-card__name">{entry.nodeType}</h3>
                    <p className="ref-card__what">{entry.what}</p>

                    <div className="ref-card__section">
                      <span className="t-caption">Why the planner picks it</span>
                      <p className="ref-card__text">{entry.why}</p>
                    </div>

                    {entry.watch && (
                      <div className="ref-card__section">
                        <span className="t-caption">What goes wrong</span>
                        <p className="ref-card__text">{entry.watch}</p>
                      </div>
                    )}

                    {borrowed && (
                      <p className="ref-card__note">
                        Diagram shared with {borrowed} — the same mechanism.
                      </p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function slug(nodeType: string): string {
  return nodeType.toLowerCase().replace(/\s+/g, '-');
}
