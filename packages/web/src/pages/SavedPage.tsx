/**
 * Named saved queries.
 *
 * Deliberately plain — the value is not in the list, it is in what the list
 * links to: each entry carries its run count and a link into plan history,
 * because "the checkout query" is only interesting once you can ask what its
 * plan has been doing lately.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type SavedQuery } from '../api';
import { Link, useRouter } from '../router';

export function SavedPage({ onOpen }: { onOpen: (sql: string) => void }) {
  const { navigate } = useRouter();
  const [queries, setQueries] = useState<SavedQuery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setQueries((await api.listSaved()).queries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <div className="alert">
        <div>{error}</div>
      </div>
    );
  }

  if (!queries) return <div className="empty"><p>Loading…</p></div>;

  if (queries.length === 0) {
    return (
      <div className="empty">
        <p>
          Nothing saved yet. Analyse a query and give it a name — every run of it is
          recorded from then on, so its plan history builds up on its own.
        </p>
      </div>
    );
  }

  return (
    <div className="group">
      {queries.map((q) => (
        <div className="group__row saved-row" key={q.id}>
          <div className="saved-row__main">
            <div className="saved-row__name">{q.name}</div>
            <code className="code saved-row__sql">{q.sql}</code>
            <div className="saved-row__meta">
              <span>
                {q.runCount === 0
                  ? 'never run'
                  : `${q.runCount} ${q.runCount === 1 ? 'run' : 'runs'}`}
              </span>
              <span>·</span>
              <span>updated {relative(q.updatedAt)}</span>
            </div>
          </div>

          <div className="saved-row__actions">
            <button
              className="btn btn--small"
              onClick={() => {
                onOpen(q.sql);
                navigate({ name: 'analyse' });
              }}
            >
              Open
            </button>
            {q.runCount > 0 && (
              <Link
                className="btn btn--small"
                to={{ name: 'history', fingerprint: q.fingerprint }}
              >
                History
              </Link>
            )}
            <button
              className="btn btn--ghost btn--small"
              onClick={async () => {
                await api.deleteSaved(q.name).catch(() => undefined);
                void load();
              }}
              aria-label={`Delete ${q.name}`}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
