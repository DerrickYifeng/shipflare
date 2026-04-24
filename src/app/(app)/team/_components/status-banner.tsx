import type { CSSProperties } from 'react';

export interface StatusBannerProps {
  activeRunId: string | null;
  activeRunStartedAt: Date | string | null;
  draftsInFlight: number;
  inReview: number;
  approvedReady: number;
  /** When true, shows the LIVE pill with a pulsing dot; else shows "Idle". */
  isLive: boolean;
  /** Short human message — "Team Lead is active.", "Team Lead is idle.", etc. */
  leadMessage: string;
}

function formatClock(input: Date | string | null): string | null {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortRunId(runId: string | null): string | null {
  if (!runId) return null;
  // Keep the first 4 and last 4 groups for a recognisable handle.
  const parts = runId.split('-');
  if (parts.length >= 2) {
    return `RUN-${parts[0].slice(0, 4).toUpperCase()}-${parts[parts.length - 1].slice(0, 2).toUpperCase()}`;
  }
  return `RUN-${runId.slice(0, 8).toUpperCase()}`;
}

export function StatusBanner({
  activeRunId,
  activeRunStartedAt,
  draftsInFlight,
  inReview,
  approvedReady,
  isLive,
  leadMessage,
}: StatusBannerProps) {
  const wrap: CSSProperties = {
    padding: '10px 14px',
    background: 'var(--sf-accent-light)',
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    marginBottom: 20,
  };

  const pill: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-link)',
  };

  const pulseDot: CSSProperties = {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: 'var(--sf-link)',
    animation: isLive ? 'var(--animate-sf-pulse)' : undefined,
  };

  const divider: CSSProperties = {
    width: 1,
    height: 12,
    background: 'rgba(0, 102, 204, 0.3)',
  };

  const primaryText: CSSProperties = {
    fontSize: 13,
    color: 'var(--sf-fg-1)',
  };

  const secondaryText: CSSProperties = {
    fontSize: 13,
    color: 'rgba(0, 0, 0, 0.56)',
  };

  const spacer: CSSProperties = {
    flex: 1,
    minWidth: 8,
  };

  const runTag: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.48)',
    fontVariantNumeric: 'tabular-nums',
  };

  const summary = `${draftsInFlight} draft${draftsInFlight === 1 ? '' : 's'} in flight · ${inReview} in review · ${approvedReady} approved & ready.`;
  const runLabel = shortRunId(activeRunId);
  const clock = formatClock(activeRunStartedAt);

  return (
    <section style={wrap} aria-label="Team status banner">
      <span style={pill}>
        <span style={pulseDot} aria-hidden="true" />
        {isLive ? 'Live' : 'Idle'}
      </span>
      <span style={divider} aria-hidden="true" />
      <span style={primaryText}>{leadMessage}</span>
      <span style={secondaryText}>{summary}</span>
      <span style={spacer} aria-hidden="true" />
      {runLabel || clock ? (
        <span style={runTag}>
          {runLabel ?? ''}
          {runLabel && clock ? ' · ' : ''}
          {clock ? `started ${clock}` : ''}
        </span>
      ) : null}
    </section>
  );
}
