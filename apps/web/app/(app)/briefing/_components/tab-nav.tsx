"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties } from "react";

const TABS: ReadonlyArray<{ label: string; href: string; matchPrefix: string }> = [
  { label: "Briefing", href: "/briefing", matchPrefix: "/briefing" },
  { label: "History", href: "/briefing/history", matchPrefix: "/briefing/history" },
  { label: "Plan", href: "/briefing/plan", matchPrefix: "/briefing/plan" },
];

const navStyle: CSSProperties = {
  display: "flex",
  gap: 24,
  padding: "0 clamp(16px, 3vw, 32px)",
  borderBottom: "1px solid var(--sf-border, rgba(0,0,0,0.08))",
};

const linkBase: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: "var(--sf-fg-3)",
  textDecoration: "none",
  padding: "10px 0",
  borderBottomWidth: 2,
  borderBottomStyle: "solid",
  borderBottomColor: "transparent",
  transition: "color 120ms, border-color 120ms",
};

const linkActive: CSSProperties = {
  ...linkBase,
  color: "var(--sf-fg-1)",
  borderBottomColor: "var(--sf-fg-1)",
};

export function TabNav() {
  const pathname = usePathname() ?? "/briefing";
  // Longest matchPrefix wins so /briefing/plan doesn't get shadowed by /briefing.
  const ordered = [...TABS].sort(
    (a, b) => b.matchPrefix.length - a.matchPrefix.length,
  );
  const active = ordered.find((t) => pathname.startsWith(t.matchPrefix));

  return (
    <nav style={navStyle} aria-label="Briefing tabs">
      {TABS.map((t) => {
        const isActive = active?.href === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            style={isActive ? linkActive : linkBase}
            aria-current={isActive ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
