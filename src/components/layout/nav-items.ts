/**
 * Single source of truth for the authenticated shell's nav set.
 *
 * Both the Sidebar (renders links with icons) and the TopNav
 * (derives the current-route label) import from here. If a route
 * is added, removed, or relabelled, update this file once and the
 * drift between Sidebar + TopNav is structurally impossible.
 *
 * Note: `matchPattern` is a RegExp that TopNav uses to resolve the
 * label for URLs that extend past the base href (e.g. `/team/lyra`).
 * If omitted it is derived from `href` as `^<href>`.
 */

import type { ComponentType } from 'react';
import {
  TodayIcon,
  ProductIcon,
  GrowthIcon,
  CalendarIcon,
  ZapIcon,
  GearIcon,
} from './nav-icons';

export interface NavItem {
  href: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  /** Optional extra regexes that should also resolve to this label (e.g. aliases / redirects). */
  aliases?: RegExp[];
}

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: '/today', label: 'Today', Icon: TodayIcon },
  {
    href: '/team',
    label: 'My AI Team',
    Icon: ZapIcon,
    // `/automation` is a server-redirect to `/team`; keep the label in sync
    // so brief flashes during redirect still read correctly.
    aliases: [/^\/automation/],
  },
  { href: '/product', label: 'My Product', Icon: ProductIcon },
  { href: '/calendar', label: 'Calendar', Icon: CalendarIcon },
  { href: '/growth', label: 'Growth', Icon: GrowthIcon },
  { href: '/settings', label: 'Settings', Icon: GearIcon },
];

/**
 * Resolve the TopNav label for a given pathname. Falls back to the
 * provided default when no nav item matches.
 */
export function resolveNavLabel(pathname: string, fallback: string): string {
  for (const item of NAV_ITEMS) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      return item.label;
    }
    if (item.aliases) {
      for (const alias of item.aliases) {
        if (alias.test(pathname)) return item.label;
      }
    }
  }
  return fallback;
}
