'use client';

/**
 * ShipFlare v2 theme provider.
 *
 * Custom, SSR-safe. Persists to localStorage under `sf-theme`. Applies
 * `.app-dark` / `.app-light` to the first descendant container (not <html>)
 * so the marketing surface (which currently always renders light) is not
 * accidentally retinted when an authenticated user has selected dark.
 *
 * The pre-paint script in <ThemeScript> runs before React hydrates and seeds
 * `document.documentElement.dataset.sfTheme`. The provider reads that seed on
 * mount to avoid a hydration mismatch on the container className.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggle: () => void;
}

const STORAGE_KEY = 'sf-theme';
const DEFAULT_THEME: Theme = 'light';

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggle: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Inline script rendered in <head> via <ThemeScript />. Runs before paint so
 * the container can pick up the right class without flicker or hydration
 * mismatch. Sets `document.documentElement.dataset.sfTheme = 'dark' | 'light'`.
 */
export function ThemeScript() {
  // Seeds the dataset so ThemeProvider.useState can read it synchronously,
  // and also flips `.app-dark` on <html> before first paint so there's no
  // theme flash between the server's `app-light` default and the hydrated
  // container class.
  const script = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var theme = stored === 'dark' || stored === 'light' ? stored : 'light';
    document.documentElement.dataset.sfTheme = theme;
    if (theme === 'dark') document.documentElement.classList.add('app-dark');
  } catch (e) {
    document.documentElement.dataset.sfTheme = 'light';
  }
})();`.trim();
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

function readInitialTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const seeded = document.documentElement.dataset.sfTheme;
  if (seeded === 'dark' || seeded === 'light') return seeded;
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Lazy init so we pick up the pre-paint script value on the first render.
  // On the server this resolves to DEFAULT_THEME; on the client it resolves
  // from the dataset seeded by ThemeScript.
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  // Safety net: if the client mounts with a value that diverges from
  // localStorage (e.g. theme changed in another tab before mount), reconcile.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') {
        if (stored !== theme) setThemeState(stored);
      }
    } catch {
      /* ignore — localStorage may be disabled */
    }
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist and sync dataset + root class whenever theme changes. Keeping
  // `.app-dark` on <html> in addition to the AppShell container means the
  // pre-paint script and React stay aligned, preventing a theme flash.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      root.dataset.sfTheme = theme;
      root.classList.toggle('app-dark', theme === 'dark');
      root.classList.toggle('app-light', theme === 'light');
    }
  }, [theme]);

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === 'dark' || event.newValue === 'light') {
        setThemeState(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
