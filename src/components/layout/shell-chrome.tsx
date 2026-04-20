'use client';

/**
 * Cross-component shell state: drawer (mobile/tablet sidebar overlay)
 * and command-palette open flags. Kept local to the shell so callers
 * outside `src/components/layout/` don't grow an import surface on
 * these concerns.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface ShellChromeContextValue {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
}

const ShellChromeContext = createContext<ShellChromeContextValue>({
  drawerOpen: false,
  setDrawerOpen: () => {},
  toggleDrawer: () => {},
  paletteOpen: false,
  setPaletteOpen: () => {},
  togglePalette: () => {},
});

export function useShellChrome(): ShellChromeContextValue {
  return useContext(ShellChromeContext);
}

export function ShellChromeProvider({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpenState] = useState(false);
  const [paletteOpen, setPaletteOpenState] = useState(false);

  const setDrawerOpen = useCallback((open: boolean) => {
    setDrawerOpenState(open);
  }, []);
  const toggleDrawer = useCallback(() => {
    setDrawerOpenState((prev) => !prev);
  }, []);
  const setPaletteOpen = useCallback((open: boolean) => {
    setPaletteOpenState(open);
  }, []);
  const togglePalette = useCallback(() => {
    setPaletteOpenState((prev) => !prev);
  }, []);

  const value = useMemo<ShellChromeContextValue>(
    () => ({
      drawerOpen,
      setDrawerOpen,
      toggleDrawer,
      paletteOpen,
      setPaletteOpen,
      togglePalette,
    }),
    [drawerOpen, setDrawerOpen, toggleDrawer, paletteOpen, setPaletteOpen, togglePalette],
  );

  return <ShellChromeContext value={value}>{children}</ShellChromeContext>;
}
