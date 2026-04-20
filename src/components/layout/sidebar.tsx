'use client';

/**
 * ShipFlare v2 Sidebar.
 *
 * Responsive behavior (INTERACTIONS.md §13):
 *  - ≥1280px → full 232px rail with labels.
 *  - 1024–1279px → 64px icon-only rail (labels hidden, hover tooltips via title).
 *  - <1024px → hidden by default; exposed as a top-drawer overlay toggled
 *    from TopNav's hamburger button. Drawer open state lives in
 *    `ShellChromeProvider` so TopNav and Sidebar stay in sync.
 *
 * Design tokens (paper-sunken bg, signal-glow overlay, gradient-active nav)
 * are preserved across all three layouts.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ComponentType, type CSSProperties } from 'react';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';
import { NAV_ITEMS } from './nav-items';
import { useShellChrome } from './shell-chrome';
import { SHELL_BREAKPOINTS, useMediaQuery } from './use-media-query';

export interface SidebarUser {
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface SidebarProps {
  user: SidebarUser;
}

type SidebarLayout = 'full' | 'rail' | 'drawer';

export function Sidebar({ user }: SidebarProps) {
  const isFullWidth = useMediaQuery(SHELL_BREAKPOINTS.desktopFull);
  const isAtLeastRail = useMediaQuery(SHELL_BREAKPOINTS.desktopRail);
  const { drawerOpen, setDrawerOpen } = useShellChrome();

  // Decide which layout mode to render based on viewport.
  // `useMediaQuery` returns false on the server and on first client render —
  // default to `full` so the SSR tree matches the desktop baseline the
  // marketing team sees on their primary resolution. The post-mount media
  // listener snaps to the accurate layout within one frame.
  const layout: SidebarLayout = isFullWidth ? 'full' : isAtLeastRail ? 'rail' : 'drawer';

  // Close the drawer whenever the viewport grows past the drawer threshold —
  // prevents the drawer from persisting as a broken overlay if the user
  // resizes past the <1024px breakpoint while it's open.
  useEffect(() => {
    if (layout !== 'drawer' && drawerOpen) {
      setDrawerOpen(false);
    }
  }, [layout, drawerOpen, setDrawerOpen]);

  // Close the drawer on Escape. Standard modal-overlay UX; parallels
  // the native <dialog> behavior used by CommandPalette.
  useEffect(() => {
    if (layout !== 'drawer' || !drawerOpen) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [layout, drawerOpen, setDrawerOpen]);

  if (layout === 'drawer') {
    return (
      <>
        {drawerOpen ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            style={DRAWER_BACKDROP_STYLE}
          />
        ) : null}
        <aside
          aria-label="Primary navigation"
          aria-hidden={!drawerOpen}
          style={{
            ...drawerStyle(drawerOpen),
          }}
        >
          <SidebarInner user={user} layout="full" onNavigate={() => setDrawerOpen(false)} />
        </aside>
      </>
    );
  }

  return (
    <aside
      aria-label="Primary navigation"
      style={{
        width: layout === 'rail' ? 64 : 232,
        flexShrink: 0,
        background: 'var(--sf-bg-tertiary)',
        borderRight: '1px solid var(--sf-border-subtle)',
        padding: layout === 'rail' ? '16px 8px' : '16px 12px',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        minHeight: '100vh',
        transition: 'width var(--sf-dur-base) var(--sf-ease-swift), padding var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      <SidebarInner user={user} layout={layout} />
    </aside>
  );
}

const DRAWER_BACKDROP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'oklch(14% 0.020 265 / 0.48)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  zIndex: 99,
  animation: 'sf-fade-in var(--sf-dur-base) var(--sf-ease-swift)',
};

function drawerStyle(open: boolean): CSSProperties {
  return {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: 'min(280px, 80vw)',
    zIndex: 100,
    background: 'var(--sf-bg-tertiary)',
    borderRight: '1px solid var(--sf-border-subtle)',
    padding: '16px 12px',
    display: 'flex',
    flexDirection: 'column',
    transform: open ? 'translateX(0)' : 'translateX(-100%)',
    transition: 'transform var(--sf-dur-base) var(--sf-ease-swift)',
    boxShadow: open ? '0 20px 60px oklch(14% 0.020 265 / 0.35)' : 'none',
  };
}

interface SidebarInnerProps {
  user: SidebarUser;
  layout: SidebarLayout;
  /** Optional: close handler invoked after a nav item is clicked (used by drawer). */
  onNavigate?: () => void;
}

function SidebarInner({ user, layout, onNavigate }: SidebarInnerProps) {
  const pathname = usePathname();
  const showLabels = layout !== 'rail';

  return (
    <>
      {/* Signal glow at top — echoes landing hero vocabulary. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(400px 260px at 0% 0%, oklch(58% 0.22 258 / 0.14), transparent 65%)',
        }}
      />

      <Link
        href="/today"
        onClick={onNavigate}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: showLabels ? 'flex-start' : 'center',
          gap: 10,
          padding: showLabels ? '0 8px' : 0,
          height: 44,
          position: 'relative',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <ShipFlareLogo size={24} />
        {showLabels ? (
          <span
            style={{
              fontSize: 'var(--sf-text-base)',
              fontWeight: 600,
              letterSpacing: 'var(--sf-track-tight)',
              color: 'var(--sf-fg-1)',
            }}
          >
            ShipFlare
          </span>
        ) : null}
      </Link>

      <nav
        aria-label="Main"
        style={{
          marginTop: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          position: 'relative',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <SidebarNavLink
              key={item.href}
              href={item.href}
              label={item.label}
              Icon={item.Icon}
              isActive={isActive}
              showLabel={showLabels}
              onNavigate={onNavigate}
            />
          );
        })}
      </nav>

      <UserCard user={user} showDetails={showLabels} onNavigate={onNavigate} />
    </>
  );
}

function SidebarNavLink({
  href,
  label,
  Icon,
  isActive,
  showLabel,
  onNavigate,
}: {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  isActive: boolean;
  showLabel: boolean;
  onNavigate?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const isHover = hover && !isActive;

  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: showLabel ? 'flex-start' : 'center',
    gap: 10,
    height: 36,
    padding: showLabel ? '0 10px' : 0,
    borderRadius: 'var(--sf-radius-md)',
    textDecoration: 'none',
    fontSize: 'var(--sf-text-sm)',
    letterSpacing: 'var(--sf-track-normal)',
    background: isActive
      ? 'linear-gradient(135deg, var(--sf-accent) 0%, oklch(50% 0.22 268) 100%)'
      : isHover
        ? 'var(--sf-bg-primary)'
        : 'transparent',
    color: isActive
      ? 'oklch(98% 0.004 85)'
      : isHover
        ? 'var(--sf-fg-1)'
        : 'var(--sf-fg-2)',
    fontWeight: isActive ? 600 : 500,
    boxShadow: isActive ? '0 6px 18px oklch(58% 0.22 258 / 0.45)' : 'none',
    transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
  };

  return (
    <Link
      href={href}
      aria-current={isActive ? 'page' : undefined}
      aria-label={!showLabel ? label : undefined}
      title={!showLabel ? label : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onNavigate}
      style={style}
    >
      <Icon />
      {showLabel ? label : null}
    </Link>
  );
}

function UserCard({
  user,
  showDetails,
  onNavigate,
}: {
  user: SidebarUser;
  showDetails: boolean;
  onNavigate?: () => void;
}) {
  const displayName = user.name ?? user.email ?? 'Signed in';
  const initials = deriveInitials(user.name, user.email);
  const secondary = user.email ?? 'SIGNED IN';

  return (
    <Link
      href="/settings"
      aria-label="Account settings"
      title={!showDetails ? displayName : undefined}
      onClick={onNavigate}
      style={{
        marginTop: 'auto',
        padding: showDetails ? 10 : 6,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: showDetails ? 'flex-start' : 'center',
        gap: 10,
        background: 'var(--sf-bg-primary)',
        border: '1px solid var(--sf-border-subtle)',
        borderRadius: 'var(--sf-radius-md)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--sf-accent), var(--sf-accent))',
          color: 'oklch(98% 0.004 85)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 'var(--sf-text-xs)',
          fontWeight: 600,
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.image}
            alt=""
            width={28}
            height={28}
            style={{ width: 28, height: 28, objectFit: 'cover' }}
          />
        ) : (
          initials
        )}
      </span>
      {showDetails ? (
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: 'block',
              fontSize: 'var(--sf-text-xs)',
              fontWeight: 500,
              color: 'var(--sf-fg-1)',
              letterSpacing: 'var(--sf-track-normal)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayName}
          </span>
          <span
            className="sf-mono"
            style={{
              display: 'block',
              fontSize: 'var(--sf-text-2xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-mono)',
              textTransform: 'uppercase',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {secondary}
          </span>
        </span>
      ) : null}
    </Link>
  );
}

function deriveInitials(name: string | null, email: string | null): string {
  const source = (name ?? email ?? '').trim();
  if (!source) return 'SF';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0]!}${parts[1]![0]!}`.toUpperCase();
  }
  const token = parts[0] ?? source;
  return token.slice(0, 2).toUpperCase();
}
