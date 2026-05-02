// Renders the onboarding "Building plan" stage as a `/team`-style chat
// transcript: a `LeadMessage` from the Chief of Staff coordinator,
// followed by a Strategist subtask card whose tool list is driven by
// real `tool_progress` SSE events.
//
// LeadMessage is reused directly from the team page (no app/context
// dependency — purely presentational). The subtask card is a local
// re-implementation of `delegation-card.tsx`'s SubtaskCard pattern: that
// component is tightly coupled to the `conversation-reducer` types, so
// rather than fork the file we paint the same visual treatment from the
// hook's pre-shaped state. Visual parity is the goal — same accent
// stripe, same status pill tone, same mono micro-row tool log.
//
// No fake cost field. No timer-driven "still thinking" placeholder past
// what the hook itself emits — every tool row corresponds to a real
// backend event.

'use client';

import type { CSSProperties } from 'react';
import { LeadMessage } from '@/app/(app)/team/_components/lead-message';
import {
  accentForAgentType,
  colorHexForAgentType,
} from '@/app/(app)/team/_components/agent-accent';
import type {
  SyntheticConversationState,
  SyntheticToolCall,
  SyntheticSubtaskStatus,
} from './synthesize-strategy-conversation';

interface SyntheticChatConversationProps {
  readonly state: SyntheticConversationState;
}

export function SyntheticChatConversation({
  state,
}: SyntheticChatConversationProps) {
  const { coordinator, subtask, elapsedMs } = state;

  const wrap: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '4px 0',
  };

  return (
    <section
      style={wrap}
      data-testid="synthetic-chat-conversation"
      aria-label="Plan-building conversation"
    >
      <LeadMessage
        agentType="coordinator"
        displayName={coordinator.name}
        createdAt={coordinator.timestamp.toISOString()}
        text={coordinator.body}
        phase={coordinator.phase}
      >
        <SubtaskShell
          title={subtask.title}
          specialistName={subtask.specialistName}
          specialistRole={subtask.specialistRole}
          firstMessage={subtask.firstMessage}
          status={subtask.status}
          toolCalls={subtask.toolCalls}
          errorMessage={subtask.errorMessage}
          elapsedMs={elapsedMs}
        />
      </LeadMessage>
    </section>
  );
}

interface SubtaskShellProps {
  readonly title: string;
  readonly specialistName: string;
  readonly specialistRole: string;
  readonly firstMessage: string;
  readonly status: SyntheticSubtaskStatus;
  readonly toolCalls: readonly SyntheticToolCall[];
  readonly errorMessage: string | null;
  readonly elapsedMs: number;
}

/**
 * The /team `DelegationCard` is wrapped in a sectioned container with a
 * "⊕ DISPATCH · TEAM LEAD → N SPECIALISTS" header. We render the same
 * shell so the visual hierarchy reads identically — even though there's
 * only ever one specialist in the onboarding flow.
 */
function SubtaskShell(props: SubtaskShellProps) {
  const wrap: CSSProperties = {
    marginTop: 10,
    background: 'var(--sf-bg-primary)',
    borderRadius: 12,
    padding: '14px 14px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    border: '1px solid rgba(0, 0, 0, 0.06)',
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--sf-fg-2)',
  };

  const hairline: CSSProperties = {
    flex: 1,
    height: 1,
    background: 'rgba(0, 0, 0, 0.06)',
  };

  return (
    <section style={wrap} aria-label="Dispatched subtasks">
      <div style={header}>
        <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>
          ⊕
        </span>
        <span>Dispatch</span>
        <span aria-hidden="true">·</span>
        <span>Team Lead → 1&nbsp;Specialist</span>
        <span style={hairline} aria-hidden="true" />
      </div>
      <SubtaskBody {...props} />
    </section>
  );
}

function SubtaskBody({
  title,
  specialistName,
  specialistRole,
  firstMessage,
  status,
  toolCalls,
  errorMessage,
  elapsedMs,
}: SubtaskShellProps) {
  // Strategist isn't a registered agent type in the team accent map, so
  // pull the content-planner palette as a sensible visual stand-in
  // (warm orange — distinct from the coordinator's neutral disc and from
  // the community/purple tone). Falls back through the same "?": grey
  // fallback path the team page uses for unknown types.
  const agentType = 'content-planner';
  const accent = accentForAgentType(agentType);
  const borderColor = accent?.solid ?? colorHexForAgentType(agentType);

  const card: CSSProperties = {
    position: 'relative',
    padding: '10px 12px 10px 16px',
    borderRadius: 8,
    background: 'var(--sf-bg-secondary)',
    border: '1px solid rgba(0, 0, 0, 0.05)',
  };

  const leftRule: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 3,
    borderRadius: 2,
    background: borderColor,
  };

  const topRow: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  };

  const titleStyle: CSSProperties = {
    fontSize: 13.5,
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
    letterSpacing: '-0.01em',
    lineHeight: 1.35,
    flex: 1,
    minWidth: 0,
  };

  const metaRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  };

  const memberStyle: CSSProperties = {
    color: accent?.ink ?? borderColor,
  };

  const subtaskStyle: CSSProperties = {
    color: 'var(--sf-fg-4)',
  };

  const firstMessageStyle: CSSProperties = {
    margin: '4px 0 8px',
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--sf-fg-2)',
    letterSpacing: '-0.005em',
  };

  return (
    <div style={card} data-testid="onboarding-subtask-card" data-status={status}>
      <span style={leftRule} aria-hidden="true" />
      <div style={topRow}>
        <span style={titleStyle}>{title}</span>
        <StatusBadge status={status} elapsedMs={elapsedMs} />
      </div>
      <div style={metaRow}>
        <span style={memberStyle}>{specialistName}</span>
        <span aria-hidden="true">·</span>
        <span style={subtaskStyle}>{specialistRole.replace(`${specialistName.toUpperCase()} · `, '')}</span>
      </div>
      <p style={firstMessageStyle}>{firstMessage}</p>
      {toolCalls.length > 0 ? (
        <ToolCallList toolCalls={toolCalls} accentColor={borderColor} />
      ) : status === 'RUNNING' ? (
        <ThinkingRow accentColor={borderColor} />
      ) : null}
      {status === 'ERROR' && errorMessage ? (
        <ErrorRow message={errorMessage} />
      ) : null}
    </div>
  );
}

function ToolCallList({
  toolCalls,
  accentColor,
}: {
  toolCalls: readonly SyntheticToolCall[];
  accentColor: string;
}) {
  const list: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '6px 0 4px',
  };
  return (
    <div style={list} aria-label="Tool calls">
      {toolCalls.map((t) => (
        <ToolCallRow key={t.toolUseId} call={t} accentColor={accentColor} />
      ))}
    </div>
  );
}

function ToolCallRow({
  call,
  accentColor,
}: {
  call: SyntheticToolCall;
  accentColor: string;
}) {
  const isRunning = call.phase === 'start';
  const isError = call.phase === 'error';
  const base: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: isError ? 'var(--sf-error-ink)' : 'var(--sf-fg-3)',
    lineHeight: 1.5,
  };
  const treeMark: CSSProperties = {
    color: 'var(--sf-fg-4)',
    flexShrink: 0,
  };
  const elapsed: CSSProperties = {
    color: 'var(--sf-fg-4)',
    marginLeft: 'auto',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  };
  const labelStyle: CSSProperties = {
    fontWeight: 500,
    color: isError ? 'var(--sf-error-ink)' : 'var(--sf-fg-2)',
  };
  const indicatorStyle: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: isRunning ? accentColor : 'transparent',
    border: isRunning ? 'none' : `1.5px solid ${
      isError ? 'var(--sf-error-ink)' : 'var(--sf-success-ink)'
    }`,
    display: 'inline-block',
    flexShrink: 0,
    animation: isRunning ? 'sf-onb-tool-pulse 1.2s ease-in-out infinite' : undefined,
  };
  const elapsedLabel = formatDuration(call.durationMs);
  return (
    <div style={base}>
      <span style={treeMark}>└</span>
      <span style={indicatorStyle} aria-hidden="true" />
      <span style={labelStyle}>{call.friendlyLabel}</span>
      {elapsedLabel ? <span style={elapsed}>{elapsedLabel}</span> : null}
      <style jsx>{`
        @keyframes sf-onb-tool-pulse {
          0%,
          100% {
            opacity: 0.45;
            transform: scale(0.85);
          }
          50% {
            opacity: 1;
            transform: scale(1.1);
          }
        }
      `}</style>
    </div>
  );
}

function StatusBadge({
  status,
  elapsedMs,
}: {
  status: SyntheticSubtaskStatus;
  elapsedMs: number;
}) {
  let label: string;
  let fg: string;
  let bg: string;
  switch (status) {
    case 'DONE':
      label = `DONE · ${formatElapsed(elapsedMs)}`;
      fg = 'var(--sf-success-ink)';
      bg = 'color-mix(in oklch, var(--sf-success) 18%, transparent)';
      break;
    case 'ERROR':
      label = 'FAILED';
      fg = 'var(--sf-error-ink)';
      bg = 'color-mix(in oklch, var(--sf-error) 16%, transparent)';
      break;
    case 'RUNNING':
    default:
      label = `RUNNING · ${formatElapsed(elapsedMs)}`;
      fg = 'var(--sf-accent)';
      bg = 'color-mix(in oklch, var(--sf-accent) 14%, transparent)';
      break;
  }
  const isRunning = status === 'RUNNING';
  const pill: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 4,
    background: bg,
    color: fg,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 9.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    animation: isRunning ? 'sf-onb-running-breath 1.8s ease-in-out infinite' : undefined,
  };
  return (
    <span style={pill}>
      {label}
      <style jsx>{`
        @keyframes sf-onb-running-breath {
          0%,
          100% {
            opacity: 0.7;
          }
          50% {
            opacity: 1;
          }
        }
      `}</style>
    </span>
  );
}

function ThinkingRow({ accentColor }: { accentColor: string }) {
  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-3)',
    letterSpacing: 0.2,
  };
  const dotBase: CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: accentColor,
    animation: 'sf-onb-subtask-pulse 1.2s ease-in-out infinite',
  };
  return (
    <div style={row}>
      <span style={{ display: 'inline-flex', gap: 3 }}>
        <span style={{ ...dotBase, animationDelay: '0ms' }} />
        <span style={{ ...dotBase, animationDelay: '180ms' }} />
        <span style={{ ...dotBase, animationDelay: '360ms' }} />
      </span>
      <span>thinking…</span>
      <style jsx>{`
        @keyframes sf-onb-subtask-pulse {
          0%,
          80%,
          100% {
            opacity: 0.3;
            transform: scale(0.85);
          }
          40% {
            opacity: 1;
            transform: scale(1.1);
          }
        }
      `}</style>
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  const wrap: CSSProperties = {
    marginTop: 8,
    padding: '8px 10px',
    borderRadius: 6,
    background: 'color-mix(in oklch, var(--sf-error) 8%, transparent)',
    borderLeft: '2px solid var(--sf-error)',
    color: 'var(--sf-error-ink)',
    fontSize: 12.5,
    lineHeight: 1.5,
  };
  return (
    <div style={wrap} role="alert">
      <span style={{ fontWeight: 600, marginRight: 6 }}>✕</span>
      {message}
    </div>
  );
}

function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}
