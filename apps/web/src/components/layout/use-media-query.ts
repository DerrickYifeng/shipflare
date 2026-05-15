'use client';

import { useSyncExternalStore } from 'react';

/**
 * SSR-safe media query hook backed by `useSyncExternalStore` — the
 * React-18-blessed primitive for subscribing to external state without
 * tripping the `react-hooks/set-state-in-effect` rule. The server
 * snapshot assumes the desktop baseline (matches most authenticated
 * sessions); the client re-evaluates after hydration and commits the
 * real value with `useSyncExternalStore`'s post-mount reconciliation.
 */
export function useMediaQuery(
  query: string,
  serverFallback: boolean = true,
): boolean {
  return useSyncExternalStore(
    (listener) => subscribe(query, listener),
    () => getSnapshot(query),
    () => serverFallback,
  );
}

function subscribe(query: string, listener: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(query);
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}

function getSnapshot(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

/** Named breakpoints — keep in sync with INTERACTIONS.md §13. */
export const SHELL_BREAKPOINTS = {
  /** Sidebar collapses to 64px icon rail below this. */
  desktopFull: '(min-width: 1280px)',
  /** Sidebar becomes a drawer triggered by hamburger below this. */
  desktopRail: '(min-width: 1024px)',
} as const;
