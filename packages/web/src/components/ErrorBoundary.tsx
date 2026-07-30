/**
 * Catches a render crash and shows something useful instead of a white screen.
 *
 * A tool whose whole proposition is "trust this because it was verified" cannot
 * fail by silently rendering nothing — the failure has to be visible and
 * recoverable, and it must not take the URL down with it, so the reload button
 * keeps the current route.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[query-not] render failed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="main">
        <div className="alert">
          <div>
            <strong>Something in the interface crashed.</strong>
          </div>
          <div className="alert__hint">
            The analysis itself is unaffected — this is a rendering fault, and your recorded runs
            are still on disk. The details are in the browser console.
          </div>
          <pre className="code" style={{ marginTop: 'var(--sp-4)', whiteSpace: 'pre-wrap' }}>
            {error.message}
          </pre>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)' }}>
            <button className="btn btn--primary btn--small" onClick={() => window.location.reload()}>
              Reload this page
            </button>
            <button
              className="btn btn--small"
              onClick={() => {
                window.location.href = '/';
              }}
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
