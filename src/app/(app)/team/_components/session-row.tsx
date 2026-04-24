'use client';

import type { CSSProperties } from 'react';
import {
  formatStart,
  statusTone,
  toneColor,
  triggerLabel,
  type SessionMeta,
} from './session-meta';

export interface SessionRowProps {
  session: SessionMeta;
  active: boolean;
  onSelect: (runId: string) => void;
}

const GOAL_MAX = 48;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function SessionRow({ session, active, onSelect }: SessionRowProps) {
  const { dot } = toneColor(statusTone(session.status));

  const hasTitle = !!(session.title && session.title.length > 0);

  const wrap: CSSProperties = {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '10px 1fr auto',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    minHeight: 44,
    border: 0,
    background: active ? 'var(--sf-bg-secondary)' : 'transparent',
    borderRadius: 8,
    textAlign: 'left',
    cursor: 'pointer',
    color: 'var(--sf-fg-1)',
    fontFamily: 'inherit',
  };

  const dotStyle: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: dot,
    marginLeft: 1,
  };

  const body: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    gap: 2,
  };

  const titleStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
    lineHeight: 1.3,
    letterSpacing: '-0.01em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const metaRow: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    minWidth: 0,
  };

  const triggerChip: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-fg-3)',
    whiteSpace: 'nowrap',
  };

  const time: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const fallbackLabel: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-fg-2)',
    whiteSpace: 'nowrap',
  };

  const goal: CSSProperties = {
    fontSize: 12,
    color: 'var(--sf-fg-3)',
    lineHeight: 1.35,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const turns: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };

  const goalText = session.goal ? truncate(session.goal, GOAL_MAX) : '—';

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      style={wrap}
      data-testid="session-row"
      data-run-id={session.id}
      data-active={active ? 'true' : 'false'}
      aria-pressed={active}
      aria-label={`Session ${session.title ?? triggerLabel(session.trigger)}, ${session.status}, ${formatStart(session.startedAt)}`}
    >
      <span style={dotStyle} aria-hidden="true" />
      <span style={body}>
        {hasTitle ? (
          <>
            <span style={titleStyle} data-testid="session-row-title">
              {session.title}
            </span>
            <span style={metaRow}>
              <span style={triggerChip}>{triggerLabel(session.trigger)}</span>
              <span style={time}>{formatStart(session.startedAt)}</span>
            </span>
          </>
        ) : (
          <>
            <span style={metaRow}>
              <span style={fallbackLabel}>{triggerLabel(session.trigger)}</span>
              <span style={time}>{formatStart(session.startedAt)}</span>
            </span>
            <span style={goal}>{goalText}</span>
          </>
        )}
      </span>
      <span style={turns} aria-label={`${session.totalTurns} turns`}>
        {session.totalTurns}
      </span>
    </button>
  );
}
