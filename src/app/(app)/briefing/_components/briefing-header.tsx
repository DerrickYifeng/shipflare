'use client';

/**
 * BriefingHeader — pure render for the Briefing page hero.
 *
 * Four states, branched in priority order:
 *   1. summary === null            → neutral fallback ("Today")
 *   2. summary.isDay1 === true     → onboarding "plan locked" hero
 *   3. allClear (caught up + 1+ shipped today) → "All clear" hero
 *   4. default                     → steady-state three-line layout
 *
 * Inline styles + CSS variables (`--sf-fg-1`, `--sf-fg-2`,
 * `--sf-text-xl`) follow the same pattern as
 * `src/components/layout/header-bar.tsx`. No CSS module / no Tailwind.
 */

import type { CSSProperties } from 'react';
import type { BriefingSummary } from '@/app/api/briefing/summary/route';

export interface BriefingHeaderProps {
  summary: BriefingSummary | null;
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '20px clamp(16px, 3vw, 32px) 12px',
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: 'var(--sf-fg-1)',
  fontSize: 'var(--sf-text-xl)',
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  color: 'var(--sf-fg-2)',
  fontSize: 14,
};

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

function buildTodayLine(today: BriefingSummary['today']): string {
  const parts = [
    `Today · ${today.awaiting} awaiting`,
    `${today.shipped} shipped`,
  ];
  if (today.skipped > 0) {
    parts.push(`${today.skipped} skipped`);
  }
  return parts.join(' · ');
}

function buildYesterdayLine(yesterday: BriefingSummary['yesterday']): string {
  const tail =
    yesterday.skipped > 0
      ? `shipped ${yesterday.shipped}, skipped ${yesterday.skipped}`
      : `shipped ${yesterday.shipped}`;
  return `Yesterday · ${tail}`;
}

export function BriefingHeader({ summary }: BriefingHeaderProps) {
  if (!summary) {
    return (
      <header style={containerStyle}>
        <h1 style={titleStyle}>Today</h1>
      </header>
    );
  }

  if (summary.isDay1) {
    const queued = summary.thisWeek.totalQueued;
    return (
      <header style={containerStyle}>
        <h1 style={titleStyle}>Day 1 · plan locked</h1>
        <p style={subtitleStyle}>
          Your team committed to {queued} {pluralize(queued, 'item', 'items')} this week.
        </p>
      </header>
    );
  }

  const { awaiting, shipped } = summary.today;
  const totalQueued = summary.thisWeek.totalQueued;
  const allClear = awaiting === 0 && totalQueued === 0 && shipped >= 1;

  if (allClear) {
    return (
      <header style={containerStyle}>
        <h1 style={titleStyle}>All clear · {shipped} shipped today</h1>
        <p style={subtitleStyle}>Discovery runs every few hours.</p>
      </header>
    );
  }

  return (
    <header style={containerStyle}>
      <h1 style={titleStyle}>{buildTodayLine(summary.today)}</h1>
      <p style={subtitleStyle}>This week · {totalQueued} more queued</p>
      <p style={subtitleStyle}>{buildYesterdayLine(summary.yesterday)}</p>
    </header>
  );
}
