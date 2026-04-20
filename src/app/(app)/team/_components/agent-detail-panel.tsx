'use client';

/**
 * Slide-in detail drawer. Positioned absolutely inside the scene wrapper so
 * it reads as "unfolding" from the right edge of the office view. Keeps
 * `position: absolute` + CSS `transform` to avoid reflow.
 */

import type { CSSProperties, ReactNode } from 'react';
import { Ops } from '@/components/ui/ops';
import { StatusPill } from './status-pill';
import type { AgentEntry } from './agent-roster';
import type { AgentPanelState } from './agent-sidebar-panel';

export interface HandoffHistoryItem {
  when: string;
  from: string;
  to: string;
  label: string;
}

export interface AgentDetailPanelProps {
  agent: AgentEntry | null;
  state: AgentPanelState | null;
  history: HandoffHistoryItem[];
  recentLog: string[];
  onClose: () => void;
}

export function AgentDetailPanel({
  agent,
  state,
  history,
  recentLog,
  onClose,
}: AgentDetailPanelProps) {
  const open = agent !== null && state !== null;
  const wrapperStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 320,
    maxWidth: '90%',
    background: 'var(--sf-paper)',
    borderLeft: '1px solid var(--sf-border-subtle)',
    boxShadow: open ? 'var(--sf-shadow-lg)' : 'none',
    transform: open ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform var(--sf-dur-slow) var(--sf-ease-swift)',
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
    borderTopRightRadius: 'var(--sf-radius-lg)',
    borderBottomRightRadius: 'var(--sf-radius-lg)',
    overflow: 'hidden',
  };

  return (
    <div style={wrapperStyle} aria-hidden={!open}>
      {open && agent && state && (
        <>
          <DrawerHeader agent={agent} onClose={onClose} />
          <div style={{ padding: 18, flex: 1, overflowY: 'auto' }}>
            <Ops style={{ display: 'block', marginBottom: 8 }}>Currently</Ops>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <StatusPill status={state.status} />
            </div>
            <p style={CURRENT_TASK_STYLE}>{state.task || '—'}</p>

            {state.progress > 0 && state.progress < 1 && (
              <ProgressBar progress={state.progress} />
            )}

            <Divider />

            <Ops style={{ display: 'block', marginBottom: 10 }}>Recent tool calls</Ops>
            {recentLog.length === 0 ? (
              <Placeholder>No tool activity yet this session.</Placeholder>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {recentLog.slice(-6).reverse().map((entry, i) => (
                  <code
                    key={`${entry}-${i}`}
                    className="sf-mono"
                    style={LOG_ENTRY_STYLE}
                  >
                    {entry}
                  </code>
                ))}
              </div>
            )}

            <Divider />

            <Ops style={{ display: 'block', marginBottom: 10 }}>Recent handoffs</Ops>
            {history.length === 0 ? (
              <Placeholder>No handoffs yet this session.</Placeholder>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {history.map((h, i) => (
                  <div key={`${h.when}-${i}`} style={HANDOFF_ROW_STYLE}>
                    <div className="sf-mono" style={HANDOFF_META_STYLE}>
                      {h.when} · {h.from} → {h.to}
                    </div>
                    <div style={{ fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-1)' }}>
                      {h.label}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface DrawerHeaderProps {
  agent: AgentEntry;
  onClose: () => void;
}

function DrawerHeader({ agent, onClose }: DrawerHeaderProps) {
  return (
    <div
      style={{
        padding: '16px 18px',
        borderBottom: '1px solid var(--sf-border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: agent.hue,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'oklch(98% 0 0)',
          fontWeight: 700,
          fontSize: 14,
          letterSpacing: 'var(--sf-track-normal)',
        }}
      >
        {agent.name[0]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--sf-text-base)', fontWeight: 600, color: 'var(--sf-fg-1)' }}>
          {agent.name}
        </div>
        <div style={{ fontSize: 'var(--sf-text-xs)', color: 'var(--sf-fg-3)' }}>
          {agent.role} agent
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close agent detail"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 6,
          color: 'var(--sf-fg-3)',
          font: 'inherit',
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          height: 3,
          background: 'var(--sf-paper-sunken)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.min(100, Math.max(0, progress * 100))}%`,
            height: '100%',
            background: 'var(--sf-signal)',
            transition: 'width var(--sf-dur-slow) var(--sf-ease-swift)',
          }}
        />
      </div>
    </div>
  );
}

function Divider() {
  return (
    <div
      role="presentation"
      style={{
        height: 1,
        background: 'var(--sf-border-subtle)',
        margin: '18px 0',
      }}
    />
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 'var(--sf-text-sm)',
        color: 'var(--sf-fg-3)',
        fontStyle: 'italic',
      }}
    >
      {children}
    </p>
  );
}

const CURRENT_TASK_STYLE: CSSProperties = {
  margin: '0 0 14px',
  fontSize: 'var(--sf-text-sm)',
  color: 'var(--sf-fg-1)',
  lineHeight: 'var(--sf-lh-normal)',
};

const LOG_ENTRY_STYLE: CSSProperties = {
  fontSize: 11,
  color: 'var(--sf-fg-2)',
  background: 'var(--sf-paper-sunken)',
  padding: '4px 8px',
  borderRadius: 'var(--sf-radius-sm, 6px)',
  letterSpacing: 'var(--sf-track-mono)',
  wordBreak: 'break-all',
};

const HANDOFF_ROW_STYLE: CSSProperties = {
  padding: 10,
  borderRadius: 'var(--sf-radius-md)',
  background: 'var(--sf-paper-sunken)',
};

const HANDOFF_META_STYLE: CSSProperties = {
  fontSize: 10,
  color: 'var(--sf-fg-3)',
  letterSpacing: 'var(--sf-track-mono)',
  marginBottom: 4,
};
