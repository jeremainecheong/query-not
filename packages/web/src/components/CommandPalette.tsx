/**
 * ⌘K navigation.
 *
 * Eight routes is past the point where a header nav is the fastest way around,
 * and the operation reference has twenty-four entries that are otherwise only
 * reachable by scrolling. This searches both.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { NODE_TYPES } from '@query-not/core';

import { useRouter, type Route } from '../router';

interface Item {
  id: string;
  label: string;
  hint: string;
  route: Route;
  /** Set for reference entries, so the palette can scroll to the card. */
  anchor?: string;
}

const PAGES: Item[] = [
  { id: 'analyse', label: 'Analyse a query', hint: 'Page', route: { name: 'analyse' } },
  { id: 'workload', label: 'Workload', hint: 'Page', route: { name: 'workload' } },
  { id: 'queries', label: 'Query history', hint: 'Page', route: { name: 'queries' } },
  { id: 'saved', label: 'Saved queries', hint: 'Page', route: { name: 'saved' } },
  { id: 'decisions', label: 'Decisions', hint: 'Page', route: { name: 'decisions' } },
  { id: 'reference', label: 'Operation reference', hint: 'Page', route: { name: 'reference' } },
  { id: 'home', label: 'Home', hint: 'Page', route: { name: 'home' } },
];

const OPERATIONS: Item[] = NODE_TYPES.map((n) => ({
  id: `op-${n.nodeType}`,
  label: n.nodeType,
  hint: 'Operation',
  route: { name: 'reference' } as Route,
  anchor: n.nodeType.toLowerCase().replace(/\s+/g, '-'),
}));

const ALL = [...PAGES, ...OPERATIONS];

export function CommandPalette() {
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setActive(0);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return PAGES;
    return ALL.filter((i) => i.label.toLowerCase().includes(needle)).slice(0, 12);
  }, [query]);

  if (!open) return null;

  function go(item: Item) {
    setOpen(false);
    navigate(item.route);
    if (item.anchor) {
      // The reference page has to render before the anchor exists.
      requestAnimationFrame(() =>
        setTimeout(() => document.getElementById(item.anchor as string)?.scrollIntoView({ block: 'center' }), 60),
      );
    }
  }

  return (
    <div className="palette" onClick={() => setOpen(false)} role="presentation">
      <div className="palette__panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Go to a page, or find an operation…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const item = results[active];
              if (item) go(item);
            }
          }}
          aria-label="Search pages and operations"
        />

        <div className="palette__results">
          {results.length === 0 && <div className="palette__empty">Nothing matches.</div>}
          {results.map((item, i) => (
            <button
              key={item.id}
              className={`palette__item${i === active ? ' palette__item--active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(item)}
            >
              <span>{item.label}</span>
              <span className="palette__hint">{item.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
