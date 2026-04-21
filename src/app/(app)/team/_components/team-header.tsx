'use client';

import type { CSSProperties } from 'react';
import { Badge } from '@/components/ui/badge';

export interface TeamHeaderActiveRun {
  runId: string;
  startedAt: string | Date | null;
  trigger?: string | null;
}

export interface TeamHeaderProps {
  teamName: string;
  activeRun: TeamHeaderActiveRun | null;
  lastRun?: {
    status: string;
    completedAt: string | Date | null;
  } | null;
  totalCostThisWeekUsd: number;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '< $0.01';
  return `$${n.toFixed(2)}`;
}

function relativeTime(input: string | Date | null): string {
  if (!input) return 'never';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return 'never';
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function TeamHeader({
  teamName,
  activeRun,
  lastRun,
  totalCostThisWeekUsd,
}: TeamHeaderProps) {
  const wrap: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    paddingBottom: 'var(--sf-space-xl)',
    borderBottom: '1px solid var(--sf-border-subtle)',
    marginBottom: 'var(--sf-space-2xl)',
  };

  const titleRow: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    flexWrap: 'wrap',
  };

  const title: CSSProperties = {
    fontFamily: 'var(--sf-font-display)',
    fontSize: 'var(--sf-text-h1)',
    fontWeight: 600,
    color: 'var(--sf-fg-1)',
    letterSpacing: '-0.015em',
    margin: 0,
    lineHeight: 1.1,
  };

  const subtitle: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-3)',
    margin: 0,
  };

  const metaRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sf-space-lg)',
    flexWrap: 'wrap',
    marginTop: 4,
  };

  const metaItem: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-2)',
  };

  const metaLabel: CSSProperties = {
    color: 'var(--sf-fg-3)',
  };

  const metaValue: CSSProperties = {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 500,
  };

  let runStatusNode: React.ReactNode;
  if (activeRun) {
    runStatusNode = (
      <>
        <Badge variant="accent">Running</Badge>
        <span style={metaLabel}>started {relativeTime(activeRun.startedAt)}</span>
      </>
    );
  } else if (lastRun) {
    const variant =
      lastRun.status === 'completed'
        ? 'success'
        : lastRun.status === 'failed'
          ? 'error'
          : 'default';
    runStatusNode = (
      <>
        <Badge variant={variant}>{lastRun.status}</Badge>
        <span style={metaLabel}>{relativeTime(lastRun.completedAt)}</span>
      </>
    );
  } else {
    runStatusNode = (
      <span style={{ ...metaValue, color: 'var(--sf-fg-3)' }}>
        Your team hasn&rsquo;t started yet.
      </span>
    );
  }

  return (
    <header style={wrap}>
      <div style={titleRow}>
        <h1 style={title}>{teamName}</h1>
      </div>
      <p style={subtitle}>
        Watch your AI marketing team plan, draft, and schedule together.
      </p>

      <div style={metaRow} aria-label="Team status">
        <div style={metaItem}>
          <span style={metaLabel}>Activity</span>
          {runStatusNode}
        </div>
        <div style={metaItem}>
          <span style={metaLabel}>This week</span>
          <span style={metaValue}>{formatUsd(totalCostThisWeekUsd)}</span>
        </div>
      </div>
    </header>
  );
}
