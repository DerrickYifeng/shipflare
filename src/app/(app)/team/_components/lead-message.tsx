import type { CSSProperties, ReactNode } from 'react';
import { AgentDot } from './agent-dot';
import { colorHexForAgentType, initialForAgent } from './agent-accent';
import { PhaseTag, type Phase } from './phase-tag';
import { MessageMarkdown } from './message-markdown';

export interface LeadMessageProps {
  agentType: string;
  displayName: string;
  createdAt: string;
  text: string;
  /**
   * Client-derived label for what this message represents in the
   * conversation flow — PLAN, DISPATCH, SYNTHESIS, DONE, etc. Supplied by
   * the conversation reducer; renderer just paints the pill.
   */
  phase?: Phase;
  /**
   * True while a partial SSE stream is still delivering text for this
   * message. Renders a three-dot breathing indicator to signal "more is
   * coming" without the caller having to animate anything itself.
   */
  streaming?: boolean;
  children?: ReactNode;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LeadMessage({
  agentType,
  displayName,
  createdAt,
  text,
  phase,
  streaming,
  children,
}: LeadMessageProps) {
  const row: CSSProperties = {
    display: 'flex',
    gap: 10,
    marginBottom: 14,
    animation: 'var(--animate-sf-fade-in)',
  };

  const body: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    flex: 1,
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
  };

  const name: CSSProperties = {
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
    letterSpacing: '-0.01em',
  };

  const time: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.48)',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div style={row} data-testid="lead-message" data-streaming={streaming ? 'true' : 'false'}>
      <AgentDot
        color={colorHexForAgentType(agentType)}
        initial={initialForAgent(agentType, displayName)}
        size={28}
      />
      <div style={body}>
        <div style={header}>
          <span style={name}>{displayName}</span>
          {phase ? <PhaseTag phase={phase} /> : null}
          <time dateTime={createdAt} style={time}>
            {formatClock(createdAt)}
          </time>
        </div>
        {text || streaming ? (
          <MessageMarkdown
            text={text}
            trailing={streaming ? <StreamingDots /> : null}
          />
        ) : null}
        {children}
      </div>
    </div>
  );
}

// Claude.ai-style three-dot breathing indicator. Purely visual — the
// actual stream state lives on the partialMessages map in
// useTeamEvents. Kept in this file so there's no extra component churn
// for a 10-line flourish.
function StreamingDots() {
  const wrap: CSSProperties = {
    display: 'inline-flex',
    gap: 3,
    alignItems: 'center',
    marginLeft: 6,
    verticalAlign: 'baseline',
  };
  const dot: CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'currentColor',
    opacity: 0.35,
    animation: 'sf-breathe 1.2s ease-in-out infinite',
  };
  return (
    <span style={wrap} aria-label="Still streaming">
      <span style={{ ...dot, animationDelay: '0ms' }} />
      <span style={{ ...dot, animationDelay: '180ms' }} />
      <span style={{ ...dot, animationDelay: '360ms' }} />
      <style jsx>{`
        @keyframes sf-breathe {
          0%,
          80%,
          100% {
            opacity: 0.2;
            transform: scale(0.85);
          }
          40% {
            opacity: 0.9;
            transform: scale(1.1);
          }
        }
      `}</style>
    </span>
  );
}
