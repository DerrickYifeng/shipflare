'use client';

/**
 * ShipFlare v2 TopNav.
 *
 * - 56px tall, sticky at top, glass `--sf-glass-light` + `--sf-glass-blur`.
 * - Left: hamburger (drawer trigger, <1024px only) + current route label.
 * - Right: theme toggle, ⌘K hint (wired to command palette), avatar.
 *
 * Route labels are resolved via `resolveNavLabel` from `./nav-items` so the
 * set never drifts from the Sidebar's NAV_ITEMS.
 *
 * See INTERACTIONS.md §2 and §11.
 */

import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';
import { Ops } from '@/components/ui/ops';
import { resolveNavLabel } from './nav-items';
import { useShellChrome } from './shell-chrome';
import { SHELL_BREAKPOINTS, useMediaQuery } from './use-media-query';
import { ThemeToggleButton } from './theme-toggle-button';

interface TopNavProps {
  /** Fallback label when the route isn't in the route map. */
  fallbackLabel?: string;
  /** User initials for avatar placeholder (unused yet but accepted for forward compat). */
  userInitials?: string;
  /** User image URL to render in avatar; falls back to the signal→flare gradient. */
  userImage?: string | null;
}

const WRAPPER_STYLE: CSSProperties = {
  height: 56,
  borderBottom: '1px solid var(--sf-border-subtle)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0 24px',
  background: 'var(--sf-glass-light)',
  backdropFilter: 'var(--sf-glass-blur)',
  WebkitBackdropFilter: 'var(--sf-glass-blur)',
  position: 'sticky',
  top: 0,
  zIndex: 50,
};

export function TopNav({
  fallbackLabel = 'ShipFlare',
  userImage = null,
}: TopNavProps = {}) {
  const pathname = usePathname();
  const label = resolveNavLabel(pathname, fallbackLabel);
  const isAtLeastRail = useMediaQuery(SHELL_BREAKPOINTS.desktopRail);
  const { toggleDrawer, togglePalette } = useShellChrome();

  // Hamburger only renders when the sidebar is in drawer mode (<1024px).
  const showHamburger = !isAtLeastRail;

  return (
    <header style={WRAPPER_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {showHamburger ? (
          <HamburgerButton onClick={toggleDrawer} />
        ) : null}
        <Ops>{label}</Ops>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ThemeToggleButton />
        <CommandPaletteHintButton onClick={togglePalette} />
        <span
          aria-hidden="true"
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--sf-signal), var(--sf-flare))',
            overflow: 'hidden',
            display: 'inline-block',
          }}
        >
          {userImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={userImage}
              alt=""
              width={28}
              height={28}
              style={{ width: 28, height: 28, objectFit: 'cover', display: 'block' }}
            />
          ) : null}
        </span>
      </div>
    </header>
  );
}

function HamburgerButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 'var(--sf-radius-md)',
        border: '1px solid var(--sf-border-subtle)',
        background: 'transparent',
        color: 'var(--sf-fg-2)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M2 4h12M2 8h12M2 12h12" />
      </svg>
    </button>
  );
}

function CommandPaletteHintButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open command palette"
      className="sf-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        padding: '0 8px',
        borderRadius: 'var(--sf-radius-sm)',
        border: '1px solid var(--sf-border-subtle)',
        background: 'transparent',
        color: 'var(--sf-fg-3)',
        fontSize: 'var(--sf-text-xs)',
        letterSpacing: 'var(--sf-track-mono)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      ⌘K
    </button>
  );
}
