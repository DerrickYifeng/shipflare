'use client';

/**
 * ShipFlare v2 theme provider.
 *
 * Custom, SSR-safe. Persists to localStorage under `sf-theme`. Applies
 * `.app-dark` / `.app-light` to the first descendant container (not <html>)
 * so the marketing surface (which currently always renders light) is not
 * accidentally retinted when an authenticated user has selected dark.
 *
 * The pre-paint script in <ThemeScript> (see `./theme-script.tsx`) runs
 * before React hydrates and seeds `document.documentElement.dataset.sfTheme`.
 * The provider reads that seed on mount to avoid a hydration mismatch on the
 * container className.
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
  hydrated: boolean;
}

const STORAGE_KEY = 'sf-theme';
const DEFAULT_THEME: Theme = 'light';

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggle: () => {},
  hydrated: false,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function readClientTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  // Prefer the dataset seeded by the pre-paint script. Fall back to
  // localStorage so a stale dataset (e.g. cleared by a 3rd-party script)
  // can still recover the user's preference.
  const seeded = document.documentElement.dataset.sfTheme;
  if (seeded === 'dark' || seeded === 'light') return seeded;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignore — localStorage may be disabled */
  }
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Both SSR and the client's first render start at DEFAULT_THEME so the
  // hydrated tree matches the server output exactly. The pre-paint script
  // already set `document.documentElement.dataset.sfTheme`, so style
  // selectors on `[data-sf-theme="dark"]` paint correctly during this
  // initial frame even when our React-tracked theme is still 'light'.
  // After hydration, the effect below promotes the real theme into state
  // and flips `hydrated` so theme-dependent UI (toggles, icons) can render.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [hydrated, setHydrated] = useState(false);

  // Promote the real theme into state once we're on the client. This runs
  // after the initial render commits, so it cannot cause a hydration
  // mismatch.
  useEffect(() => {
    const real = readClientTheme();
    if (real !== theme) setThemeState(real);
    setHydrated(true);
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist and sync dataset whenever theme changes (after hydration).
  // `.app-dark` is applied ONLY to the AppShell container (see
  // `app-shell.tsx`) so marketing routes in the same document are never
  // retinted.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
    const root = document.documentElement;
    root.dataset.sfTheme = theme;
    // Defensive cleanup: remove any legacy `.app-dark` / `.app-light`
    // classes that older scripts may have written to <html>.
    root.classList.remove('app-dark');
    root.classList.remove('app-light');
  }, [theme, hydrated]);

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
    () => ({ theme, setTheme, toggle, hydrated }),
    [theme, setTheme, toggle, hydrated],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
