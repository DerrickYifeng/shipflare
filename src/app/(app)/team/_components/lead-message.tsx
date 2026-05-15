'use client';

import { memo, type CSSProperties, type ReactNode } from 'react';
import { AgentDot } from './agent-dot';
import { colorHexForAgentType, initialForAgent } from './agent-accent';
import { PhaseTag, type Phase } from './phase-tag';
import { MessageMarkdown } from './message-markdown';
import { useStreamingPartial } from './streaming-context';

export interface LeadMessageProps {
  /**
   * Stable message id (matches the durable `team_messages.id` for
   * non-streaming entries, or the in-flight stream id from
   * `useTeamEvents`'s `partials` map for streaming bubbles). Used to
   * subscribe to the per-tree `StreamingStore` for live-text overrides
   * so this leaf is the only thing that re-renders on token deltas.
   */
  messageId: string;
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

function LeadMessageImpl({
  messageId,
  agentType,
  displayName,
  createdAt,
  text,
  phase,
  streaming,
  children,
}: LeadMessageProps) {
  // While a stream is in flight, prefer the live text from the per-tree
  // `StreamingStore` over the prop-derived `text`. The prop value comes
  // from `stitchLeadMessages` and only changes when the parent reducer
  // re-runs; the context value updates on every token without re-rendering
  // any sibling. A2 will drop the prop-derived streaming path entirely
  // once the bottom rail takes over placeholder rendering.
  const live = useStreamingPartial(messageId);
  const isStreamingNow = live !== undefined || !!streaming;
  const displayText = live?.text ?? text;
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
    <div
      style={row}
      data-testid="lead-message"
      data-streaming={isStreamingNow ? 'true' : 'false'}
    >
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
        {displayText || isStreamingNow ? (
          <MessageMarkdown
            text={displayText}
            trailing={isStreamingNow ? <StreamingDots /> : null}
          />
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * Memoized public export.
 *
 * memo() wins are limited in A1: non-streaming sibling bubbles short-circuit
 * (their text and other props are stable across token deltas), but actively
 * streaming bubbles still re-render because stitchLeadMessages rebuilds their
 * `text` and `children` on every partials-map update via the still-live prop
 * path. The full win lands in A2 when the prop path drops and the only source
 * of streaming text is the streaming-context hook inside this component.
 */
export const LeadMessage = memo(LeadMessageImpl);

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
