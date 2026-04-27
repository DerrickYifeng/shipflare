import type { CSSProperties } from 'react';
import type { TeamRunMeta } from './conversation-reducer';
import {
  formatStart,
  statusTone,
  toneColor,
  triggerLabel,
} from './conversation-meta';

export interface SessionDividerProps {
  runId: string | null;
  run: TeamRunMeta | null;
  /** Used when `runId === null` (true orphan group). */
  fallbackLabel?: string;
}

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '18px 0 10px',
  marginBottom: 8,
};

const topRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const hairline: CSSProperties = {
  flex: 1,
  height: 1,
  margin: 0,
  border: 0,
  background: 'rgba(0, 0, 0, 0.06)',
};

const metaLabel: CSSProperties = {
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--sf-fg-3)',
  whiteSpace: 'nowrap',
};

const timeStyle: CSSProperties = {
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 11,
  color: 'var(--sf-fg-4)',
  fontVariantNumeric: 'tabular-nums',
};

const goalStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--sf-fg-2)',
  lineHeight: 1.45,
  margin: 0,
  paddingLeft: 1,
};

const pendingLabel: CSSProperties = {
  ...metaLabel,
  color: 'var(--sf-fg-4)',
};

const pendingBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 11,
  color: 'var(--sf-fg-4)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  whiteSpace: 'nowrap',
};

const pendingDot: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--sf-fg-4)',
};

export function SessionDivider({
  runId,
  run,
  fallbackLabel,
}: SessionDividerProps) {
  if (!run) {
    // True orphan: no runId attached to these messages.
    if (!runId) {
      return (
        <section
          style={wrap}
          aria-label={fallbackLabel ?? 'Direct messages'}
          data-testid="session-divider-orphan"
        >
          <div style={topRow}>
            <span style={metaLabel}>{fallbackLabel ?? 'Direct messages'}</span>
            <hr style={hairline} aria-hidden="true" />
          </div>
        </section>
      );
    }
    // SSE delivered messages for a runId whose metadata hasn't reached us yet.
    // Show a neutral placeholder rather than the "Direct messages" label.
    const shortId = shortRunId(runId);
    return (
      <section
        style={wrap}
        aria-label={`Session ${shortId} (loading)`}
        data-testid="session-divider-pending"
        data-run-id={runId}
      >
        <div style={topRow}>
          <span style={pendingLabel}>{`Session · ${shortId}`}</span>
          <hr style={hairline} aria-hidden="true" />
          <span style={pendingBadge} aria-label="Status loading">
            <span style={pendingDot} aria-hidden="true" />
            loading
          </span>
        </div>
      </section>
    );
  }

  const tone = statusTone(run.status);
  const { fg: toneFg, dot: toneDot } = toneColor(tone);
  const badgeStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: toneFg,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    whiteSpace: 'nowrap',
  };
  const dotStyle: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: toneDot,
  };

  const label = triggerLabel(run.trigger);
  return (
    <section
      style={wrap}
      aria-label={`Session: ${label}`}
      data-testid="session-divider"
      data-run-id={run.id}
    >
      <div style={topRow}>
        <span style={metaLabel}>{label}</span>
        <span style={timeStyle}>{formatStart(run.startedAt)}</span>
        <hr style={hairline} aria-hidden="true" />
        <span style={badgeStyle} aria-label={`Status ${run.status}`}>
          <span style={dotStyle} aria-hidden="true" />
          {run.status}
        </span>
      </div>
      {run.goal ? <p style={goalStyle}>{truncate(run.goal)}</p> : null}
    </section>
  );
}
