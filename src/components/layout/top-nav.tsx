'use client';

/**
 * ShipFlare v2 TopNav.
 *
 * - 56px tall, sticky at top, glass `--sf-glass-light` + `--sf-glass-blur`.
 * - Left: current route label as an Ops (mono uppercase) span.
 * - Right: theme toggle, ⌘K hint, avatar gradient.
 *
 * See INTERACTIONS.md §2.
 */

import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';
import { Ops } from '@/components/ui/ops';
import { ThemeToggleButton } from './theme-toggle-button';

interface TopNavProps {
  /** Fallback label when the route isn't in the route map. */
  fallbackLabel?: string;
  /** User initials for avatar placeholder (unused yet but accepted for forward compat). */
  userInitials?: string;
  /** User image URL to render in avatar; falls back to the signal→flare gradient. */
  userImage?: string | null;
}

const ROUTE_LABELS: Array<{ match: RegExp; label: string }> = [
  { match: /^\/today/, label: 'Today' },
  { match: /^\/product/, label: 'My Product' },
  { match: /^\/growth/, label: 'Growth' },
  { match: /^\/calendar/, label: 'Calendar' },
  { match: /^\/automation/, label: 'Your AI Team' },
  { match: /^\/dashboard/, label: 'Metrics' },
  { match: /^\/settings/, label: 'Settings' },
];

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
  const label = resolveLabel(pathname, fallbackLabel);

  return (
    <header style={WRAPPER_STYLE}>
      <Ops>{label}</Ops>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ThemeToggleButton />
        <span
          className="sf-mono"
          aria-hidden="true"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
            letterSpacing: 'var(--sf-track-mono)',
          }}
        >
          ⌘K
        </span>
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

function resolveLabel(pathname: string, fallback: string): string {
  for (const entry of ROUTE_LABELS) {
    if (entry.match.test(pathname)) return entry.label;
  }
  return fallback;
}
