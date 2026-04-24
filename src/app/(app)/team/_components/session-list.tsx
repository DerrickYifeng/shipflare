'use client';

import type { CSSProperties } from 'react';
import { SessionRow } from './session-row';
import type { SessionMeta } from './session-meta';

export interface SessionListProps {
  sessions: readonly SessionMeta[];
  selectedRunId: string | null;
  onSelect: (runId: string | null) => void;
  onNewSession: () => void;
  canCreateSession: boolean;
  creatingSession: boolean;
}

const MAX_HEIGHT = 264;

const NEW_SESSION_DISABLED_TOOLTIP =
  'Wait for the current session to finish — or send a follow-up in the composer.';

export function SessionList({
  sessions,
  selectedRunId,
  onSelect,
  onNewSession,
  canCreateSession,
  creatingSession,
}: SessionListProps) {
  const sectionHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px 6px',
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  const sectionLeft: CSSProperties = {
    color: 'var(--sf-fg-1)',
  };

  const sectionRight: CSSProperties = {
    color: 'rgba(0, 0, 0, 0.48)',
  };

  const newSessionButton: CSSProperties = {
    width: '100%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 32,
    margin: '2px 0 6px',
    padding: '0 12px',
    borderRadius: 8,
    border: '1px dashed rgba(0, 0, 0, 0.18)',
    background: 'transparent',
    color: canCreateSession ? 'var(--sf-fg-1)' : 'var(--sf-fg-4)',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: canCreateSession ? 'pointer' : 'not-allowed',
    opacity: canCreateSession ? 1 : 0.7,
  };

  const scroll: CSSProperties = {
    maxHeight: MAX_HEIGHT,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    paddingRight: 2,
  };

  const empty: CSSProperties = {
    padding: '10px 12px',
    fontSize: 12,
    color: 'var(--sf-fg-4)',
    fontStyle: 'italic',
  };

  const newSessionLabel = creatingSession ? 'Starting…' : '+ New session';

  return (
    <section aria-label="Session history">
      <div style={sectionHeader}>
        <span style={sectionLeft}>Sessions</span>
        <span style={sectionRight}>{`${sessions.length} recent`}</span>
      </div>

      <button
        type="button"
        onClick={onNewSession}
        disabled={!canCreateSession || creatingSession}
        aria-disabled={!canCreateSession}
        title={canCreateSession ? undefined : NEW_SESSION_DISABLED_TOOLTIP}
        style={newSessionButton}
        data-testid="new-session-button"
      >
        {newSessionLabel}
      </button>

      <div style={scroll} data-testid="session-scroll">
        {sessions.length === 0 ? (
          <div style={empty}>No past sessions</div>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={selectedRunId === s.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}
