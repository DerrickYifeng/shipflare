'use client';

import { useState, type CSSProperties } from 'react';
import { AgentDot } from './agent-dot';
import {
  colorHexForAgentType,
  initialForAgent,
  roleCodeForAgentType,
} from './agent-accent';

export type AgentRowStatus =
  | 'idle'
  | 'active'
  | 'working'
  | 'thinking'
  | 'waiting_approval'
  | 'error'
  | 'done';

const WORKING_STATUSES: ReadonlySet<AgentRowStatus> = new Set<AgentRowStatus>([
  'active',
  'working',
  'thinking',
]);

const STATUS_DOT_COLOR: Record<AgentRowStatus, string> = {
  idle: 'var(--sf-fg-4)',
  active: 'var(--sf-accent)',
  working: 'var(--sf-accent)',
  thinking: 'var(--sf-warning)',
  waiting_approval: 'var(--sf-warning)',
  error: 'var(--sf-error)',
  done: 'var(--sf-success)',
};

export interface AgentRowProps {
  memberId: string;
  agentType: string;
  displayName: string;
  status: AgentRowStatus | string;
  active?: boolean;
  taskCount?: number;
  notes?: readonly string[];
  onSelect: (memberId: string) => void;
}

function normalizeStatus(raw: string): AgentRowStatus {
  switch (raw) {
    case 'idle':
    case 'active':
    case 'working':
    case 'thinking':
    case 'waiting_approval':
    case 'error':
    case 'done':
      return raw;
    default:
      return 'idle';
  }
}

export function AgentRow({
  memberId,
  agentType,
  displayName,
  status,
  active,
  taskCount,
  notes,
  onSelect,
}: AgentRowProps) {
  const [hover, setHover] = useState(false);
  const normalized = normalizeStatus(status);
  const pulsing = WORKING_STATUSES.has(normalized);
  const color = colorHexForAgentType(agentType);
  const initial = initialForAgent(agentType, displayName);
  const code = roleCodeForAgentType(agentType);

  const button: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    width: '100%',
    textAlign: 'left',
    padding: '10px 12px',
    marginBottom: 4,
    borderRadius: 10,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'inherit',
    background: active
      ? 'var(--sf-bg-secondary)'
      : hover
        ? 'rgba(0, 0, 0, 0.03)'
        : 'transparent',
    boxShadow: active
      ? '0 0 0 1px rgba(0, 113, 227, 0.3), 0 1px 2px rgba(0, 0, 0, 0.04)'
      : undefined,
    transition: 'background 200ms var(--sf-ease-swift), box-shadow 200ms var(--sf-ease-swift)',
    outline: 'none',
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    width: '100%',
  };

  const middle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  };

  const nameRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  };

  const nameStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
    letterSpacing: '-0.16px',
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  };

  const statusDot: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: STATUS_DOT_COLOR[normalized],
    flexShrink: 0,
    animation: pulsing ? 'var(--animate-sf-pulse)' : undefined,
  };

  const codeStyle: CSSProperties = {
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    color: 'var(--sf-fg-4)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 1,
  };

  const pill: CSSProperties = {
    minWidth: 20,
    height: 20,
    padding: '0 6px',
    borderRadius: 5,
    background: active ? 'var(--sf-fg-1)' : 'rgba(0, 0, 0, 0.06)',
    color: active ? 'var(--sf-bg-secondary)' : 'rgba(0, 0, 0, 0.64)',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'var(--sf-font-mono)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  };

  const noteList: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    paddingLeft: 38,
    margin: 0,
    listStyle: 'none',
  };

  const noteItem: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.56)',
    letterSpacing: '-0.08px',
    lineHeight: 1.4,
  };

  const noteBullet: CSSProperties = {
    width: 3,
    height: 3,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  };

  const noteText: CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  };

  return (
    <button
      type="button"
      onClick={() => onSelect(memberId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-pressed={active}
      aria-label={`${displayName}, ${code.toLowerCase()}`}
      data-testid={`agent-row-${agentType}`}
      style={button}
    >
      <div style={header}>
        <AgentDot color={color} initial={initial} size={28} pulse={pulsing} />
        <div style={middle}>
          <div style={nameRow}>
            <span style={nameStyle}>{displayName}</span>
            <span style={statusDot} aria-hidden="true" />
          </div>
          <span style={codeStyle}>{code}</span>
        </div>
        {typeof taskCount === 'number' && taskCount > 0 ? (
          <span style={pill} aria-label={`${taskCount} open tasks`}>
            {taskCount}
          </span>
        ) : null}
      </div>
      {notes && notes.length > 0 ? (
        <ul style={noteList}>
          {notes.map((n) => (
            <li key={n} style={noteItem}>
              <span style={noteBullet} aria-hidden="true" />
              <span style={noteText}>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </button>
  );
}
