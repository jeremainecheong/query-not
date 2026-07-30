/**
 * A minimal History-API router.
 *
 * Four routes and no dependency. The three things a hand-rolled router
 * normally gets wrong are handled explicitly, and each is covered by a browser
 * test: the back button (popstate), deep links (parse on first render, not
 * only on navigation), and refresh (the dev server rewrites unknown paths to
 * index.html).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'analyse' }
  | { name: 'analysis'; slug: string }
  | { name: 'queries' }
  | { name: 'saved' }
  | { name: 'history'; fingerprint: string }
  | { name: 'workload' }
  | { name: 'decisions' }
  | { name: 'reference' };

export function parsePath(pathname: string): Route {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);

  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'analyse') return { name: 'analyse' };
  if (parts[0] === 'a' && parts[1]) return { name: 'analysis', slug: decodeURIComponent(parts[1]) };
  if (parts[0] === 'queries') return { name: 'queries' };
  if (parts[0] === 'saved') return { name: 'saved' };
  if (parts[0] === 'workload') return { name: 'workload' };
  if (parts[0] === 'decisions') return { name: 'decisions' };
  if (parts[0] === 'reference') return { name: 'reference' };
  if (parts[0] === 'history' && parts[1]) {
    return { name: 'history', fingerprint: decodeURIComponent(parts[1]) };
  }
  // Anything unrecognised lands on the front door rather than a dead end.
  return { name: 'home' };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case 'analyse':
      return '/analyse';
    case 'analysis':
      return `/a/${encodeURIComponent(route.slug)}`;
    case 'queries':
      return '/queries';
    case 'saved':
      return '/saved';
    case 'workload':
      return '/workload';
    case 'decisions':
      return '/decisions';
    case 'reference':
      return '/reference';
    case 'history':
      return `/history/${encodeURIComponent(route.fingerprint)}`;
    default:
      return '/';
  }
}

interface RouterValue {
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  // Parsed on first render, so a deep link works without a navigation event.
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    // The back button is a navigation the app did not initiate; without this
    // the URL changes and the view does not.
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const path = pathFor(next);
    if (path !== window.location.pathname) {
      if (options.replace) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  const value = useMemo(() => ({ route, navigate }), [route, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used inside RouterProvider');
  return ctx;
}

/**
 * An anchor that navigates client-side but is still a real link — so
 * middle-click, cmd-click and "copy link address" all behave normally.
 */
export function Link({
  to,
  children,
  className,
  onClick,
}: {
  to: Route;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const { navigate } = useRouter();
  const href = pathFor(to);

  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        // Let the browser handle modified clicks — that is what makes
        // "open in new tab" work.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
