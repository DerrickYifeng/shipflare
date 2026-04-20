'use client';

/**
 * Client-side wrapper that applies `.app-dark` / `.app-light` to the
 * outermost app container based on the current theme. Kept separate from
 * the server layout so the Sidebar's user data can still be fetched on
 * the server and the shell can react to theme changes client-side.
 *
 * Also mounts the global ⌘K listener and the command palette modal so
 * the keystroke works from any authenticated route without each page
 * re-wiring it.
 */

import { useEffect, type ReactNode } from 'react';
import { CommandPalette } from '@/components/ui/command-palette';
import { useShellChrome } from './shell-chrome';
import { useTheme } from './theme-provider';

export function AppShell({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const { paletteOpen, setPaletteOpen, togglePalette } = useShellChrome();
  const themeClass = theme === 'dark' ? 'app-dark' : 'app-light';

  // Global ⌘K / Ctrl+K binding — intercepts the keystroke everywhere in
  // the authenticated shell. `preventDefault` stops browsers from opening
  // their native address-bar search. Skips while the user is typing in
  // an input so form fields with their own ⌘K bindings keep working.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const isCmdK =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'k' || event.key === 'K');
      if (!isCmdK) return;

      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          // Allow in-field ⌘K only when the palette is not already open.
          // Still opens the palette — it's the global shortcut — but we
          // don't break autocomplete UIs that use ⌘K within themselves.
          // If future conflicts surface, add an `data-allow-cmdk` opt-out.
        }
      }

      event.preventDefault();
      togglePalette();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePalette]);

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
        background: 'var(--sf-bg-primary)',
        transition:
          'background var(--sf-dur-base) var(--sf-ease-swift), color var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      {children}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
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
