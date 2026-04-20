'use client';

/**
 * Right-rail roster panel for the /team route.
 *
 * Lists each agent with their current task, queue progress, and any stats
 * that the SSE stream surfaces. Re-uses the shared `AgentCard` primitive
 * from Phase 2 so the visual language matches Today's scan drawer.
 *
 * The panel is purely presentational — live state is owned by `TeamContent`
 * and passed in via props.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { AgentCard, type AgentStatus } from '@/components/ui/agent-card';
import { Ops } from '@/components/ui/ops';
import { Card } from '@/components/ui/card';
import {
  AGENT_ROSTER,
  type AgentEntry,
  type AgentId,
  type SceneStatus,
} from './agent-roster';

/** Per-agent snapshot derived from the SSE stream. */
export interface AgentPanelState {
  status: SceneStatus;
  task: string;
  progress: number;
  stats?: { label: string; value: ReactNode }[];
  cost?: number;
  elapsed?: number;
}

export interface AgentSidebarPanelProps {
  states: Record<AgentId, AgentPanelState>;
  selectedId: AgentId | null;
  onSelect: (id: AgentId) => void;
  isConnected: boolean;
  queueDepth: number;
}

/**
 * Map the scene's status vocabulary to the shared `AgentCard`'s 4-state
 * status so both views stay in lockstep.
 */
function agentCardStatus(status: SceneStatus): AgentStatus {
  if (status === 'idle') return 'idle';
  if (status === 'blocked') return 'failed';
  return 'active';
}

export function AgentSidebarPanel({
  states,
  selectedId,
  onSelect,
  isConnected,
  queueDepth,
}: AgentSidebarPanelProps) {
  return (
    <aside
      aria-label="Agent roster"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minWidth: 0,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          padding: '0 2px 4px',
        }}
      >
        <Ops>Roster</Ops>
        <span
          className="sf-mono"
          style={{
            fontSize: 'var(--sf-text-2xs)',
            letterSpacing: 'var(--sf-track-mono)',
            color: isConnected ? 'var(--sf-success-ink)' : 'var(--sf-fg-3)',
            textTransform: 'uppercase',
          }}
        >
          {isConnected ? 'LIVE' : 'OFFLINE'} · {queueDepth} IN FLIGHT
        </span>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {AGENT_ROSTER.map((agent) => {
          const state = states[agent.id];
          return (
            <AgentRosterRow
              key={agent.id}
              agent={agent}
              state={state}
              isSelected={selectedId === agent.id}
              onSelect={() => onSelect(agent.id)}
            />
          );
        })}
      </div>
    </aside>
  );
}

interface AgentRosterRowProps {
  agent: AgentEntry;
  state: AgentPanelState;
  isSelected: boolean;
  onSelect: () => void;
}

function AgentRosterRow({ agent, state, isSelected, onSelect }: AgentRosterRowProps) {
  const [hover, setHover] = useState(false);

  const frameStyle: CSSProperties = {
    position: 'relative',
    display: 'block',
    textAlign: 'left',
    width: '100%',
    padding: 0,
    borderRadius: 'var(--sf-radius-lg)',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    outline: isSelected
      ? '2px solid var(--sf-accent)'
      : hover
        ? '1px solid var(--sf-border)'
        : '1px solid transparent',
    outlineOffset: 0,
    transition: 'outline-color var(--sf-dur-base) var(--sf-ease-swift)',
    boxShadow: isSelected ? '0 0 0 4px oklch(70% 0.15 250 / 0.18)' : 'none',
  };

  const cardStatus = agentCardStatus(state.status);

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={isSelected}
      aria-label={`${agent.name}, ${agent.role} agent`}
      style={frameStyle}
    >
      <AgentCard
        name={`${agent.name} · ${agent.role}`}
        status={cardStatus}
        detail={state.task}
        progress={state.progress}
        stats={state.stats}
        cost={state.cost}
        elapsed={state.elapsed}
      />
    </button>
  );
}

interface BlockedHintProps {
  reason: string;
}

export function BlockedHint({ reason }: BlockedHintProps) {
  return (
    <Card padding={14} accent="error">
      <Ops tone="danger" style={{ display: 'block', marginBottom: 4 }}>
        NEEDS YOU
      </Ops>
      <p
        style={{
          margin: 0,
          fontSize: 'var(--sf-text-sm)',
          color: 'var(--sf-fg-1)',
          lineHeight: 'var(--sf-lh-normal)',
        }}
      >
        {reason}
      </p>
    </Card>
  );
}
