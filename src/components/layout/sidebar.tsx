'use client';

/**
 * ShipFlare v2 Sidebar.
 *
 * - 232px fixed width, `--sf-paper-sunken` background.
 * - Signal-glow radial gradient overlay (pointer-events: none).
 * - Nav items: 36px, gradient-active for current route, subtle hover.
 * - User card pinned to bottom with gradient avatar.
 *
 * See INTERACTIONS.md §1 for the exact dimensions and color values.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ComponentType, type CSSProperties } from 'react';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';

interface NavItem {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/today', label: 'Today', Icon: TodayIcon },
  { href: '/product', label: 'My Product', Icon: ProductIcon },
  { href: '/growth', label: 'Growth', Icon: GrowthIcon },
  { href: '/calendar', label: 'Calendar', Icon: CalendarIcon },
  { href: '/team', label: 'Your AI Team', Icon: ZapIcon },
  { href: '/settings', label: 'Settings', Icon: GearIcon },
];

export interface SidebarUser {
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface SidebarProps {
  user: SidebarUser;
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Primary navigation"
      style={{
        width: 232,
        flexShrink: 0,
        background: 'var(--sf-paper-sunken)',
        borderRight: '1px solid var(--sf-border-subtle)',
        padding: '16px 12px',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        minHeight: '100vh',
      }}
    >
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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 8px',
          height: 44,
          position: 'relative',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <ShipFlareLogo size={24} />
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
            />
          );
        })}
      </nav>

      <UserCard user={user} />
    </aside>
  );
}

function SidebarNavLink({
  href,
  label,
  Icon,
  isActive,
}: {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  isActive: boolean;
}) {
  const [hover, setHover] = useState(false);
  const isHover = hover && !isActive;

  const style: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 36,
    padding: '0 10px',
    borderRadius: 'var(--sf-radius-md)',
    textDecoration: 'none',
    fontSize: 'var(--sf-text-sm)',
    letterSpacing: 'var(--sf-track-normal)',
    background: isActive
      ? 'linear-gradient(135deg, var(--sf-signal) 0%, oklch(50% 0.22 268) 100%)'
      : isHover
        ? 'var(--sf-paper)'
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      <Icon />
      {label}
    </Link>
  );
}

function UserCard({ user }: { user: SidebarUser }) {
  const displayName = user.name ?? user.email ?? 'Signed in';
  const initials = deriveInitials(user.name, user.email);
  const secondary = user.email ?? 'SIGNED IN';

  return (
    <Link
      href="/settings"
      aria-label="Account settings"
      style={{
        marginTop: 'auto',
        padding: 10,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'var(--sf-paper)',
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
          background: 'linear-gradient(135deg, var(--sf-signal), var(--sf-flare))',
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

/* =====================================================================
   Icons — 16×16 stroke-1.5, match shell.jsx source.
   ===================================================================== */

function TodayIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4v4l2.5 1.5" />
    </svg>
  );
}

function ProductIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2 5l6-3 6 3-6 3-6-3z" />
      <path d="M2 5v6l6 3V8" />
      <path d="M14 5v6l-6 3" />
    </svg>
  );
}

function GrowthIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M1 14l4-5 3 3 7-9" />
      <path d="M11 3h4v4" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="12" rx="1" />
      <path d="M11 1v4M5 1v4M2 7h12" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M9 1L3 9h5l-1 6 6-8H8l1-6z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.8 2.8l1.4 1.4M11.8 11.8l1.4 1.4M2.8 13.2l1.4-1.4M11.8 4.2l1.4-1.4" />
    </svg>
  );
}
