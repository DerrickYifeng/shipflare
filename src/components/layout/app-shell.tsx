'use client';

/**
 * Client-side wrapper that applies `.app-dark` / `.app-light` to the
 * outermost app container based on the current theme. Kept separate from
 * the server layout so the Sidebar's user data can still be fetched on
 * the server and the shell can react to theme changes client-side.
 */

import type { ReactNode } from 'react';
import { useTheme } from './theme-provider';

export function AppShell({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const themeClass = theme === 'dark' ? 'app-dark' : 'app-light';

  return (
    <div
      // The theme class is resolved client-side from localStorage; SSR renders
      // with the default (`app-light`) and the pre-paint script sets dataset
      // so the first post-hydration render picks up the stored theme. The
      // class can differ between server and first-client render so suppress
      // the warning on this specific node.
      suppressHydrationWarning
      className={themeClass}
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--sf-paper)',
        color: 'var(--sf-fg-1)',
        transition:
          'background var(--sf-dur-base) var(--sf-ease-swift), color var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      {children}
    </div>
  );
}

export function AppCanvas({ children }: { children: ReactNode }) {
  return (
    <div
      className="app-canvas"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
      }}
    >
      {children}
    </div>
  );
}
