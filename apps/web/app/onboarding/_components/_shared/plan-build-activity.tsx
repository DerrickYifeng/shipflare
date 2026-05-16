'use client';

// Onboarding Stage 6 — real-time strategy visualization.
//
// Mirrors the /team page's conversation + activity-trail visual pattern:
//   - Card container matching sf-bg-secondary / sf-shadow-card
//   - CMO monogram dot + name header
//   - Status message with streaming dots while the strategist works
//   - Inline activity rows (dispatch → tool calls → finish) below the bubble
//
// The strategic planner outputs JSON (the StrategicPath schema), so we do NOT
// render `subagent_text_delta` content as prose — instead the status message
// is static copy that updates on subagent_dispatch / subagent_finish events.

import { useMemo, type CSSProperties } from 'react';
import { useCmoActivity } from '@/hooks/use-cmo-activity';
import { labelEvent } from '@/lib/activity-labels';
import type { ActivityEvent } from '@shipflare/shared';

interface PlanBuildActivityProps {
  runId: string;
}

// ---------------------------------------------------------------------------
// Layout constants (mirrors team-desk.tsx CENTER panel aesthetics)
// ---------------------------------------------------------------------------

const CARD: CSSProperties = {
  background: 'var(--sf-bg-secondary)',
  border: '1px solid var(--sf-border)',
  borderRadius: 'var(--sf-radius-xl)',
  boxShadow: 'var(--sf-shadow-card)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 120,
};

const SCROLL: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px 20px',
};

const MSG_ROW: CSSProperties = {
  display: 'flex',
  gap: 10,
};

const MSG_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
  flex: 1,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Monogram disc — matches team page's AgentDot (28px, CMO accent). */
function CmoDot({ pulse }: { pulse?: boolean }) {
  const style: CSSProperties = {
    width: 28,
    height: 28,
    minWidth: 28,
    borderRadius: '50%',
    background: '#1d1d1f',
    color: '#fff',
    fontFamily: 'var(--sf-font-display)',
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: 0.2,
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    userSelect: 'none',
    animation: pulse ? 'sf-pulse 1.5s ease-in-out infinite' : undefined,
  };
  return (
    <div style={style} aria-hidden="true" title="CMO">
      C
    </div>
  );
}

/** Inline breathing dots — identical to LeadMessage's StreamingDots. */
function StreamingDots() {
  const wrap: CSSProperties = {
    display: 'inline-flex',
    gap: 3,
    alignItems: 'center',
    marginLeft: 6,
    verticalAlign: 'baseline',
  };
  const dot = (delay: string): CSSProperties => ({
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'currentColor',
    opacity: 0.35,
    animation: `sf-pba-breathe 1.2s ease-in-out ${delay} infinite`,
  });
  return (
    <span style={wrap} aria-label="Still thinking">
      <span style={dot('0ms')} />
      <span style={dot('180ms')} />
      <span style={dot('360ms')} />
      <style>{`
        @keyframes sf-pba-breathe {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
          40%            { opacity: 0.9; transform: scale(1.1);  }
        }
      `}</style>
    </span>
  );
}

/** One activity event row — mirrors ActivityRow but in inline styles. */
function ActivityLine({
  event,
  running,
}: {
  event: ActivityEvent;
  running: boolean;
}) {
  const label = labelEvent(event);
  const isFinish = event.kind.endsWith('_finish');
  const isError = (event.payload as { status?: string }).status === 'error';
  const icon = running && !isFinish ? '◐' : isError ? '✕' : '✓';

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    padding: '2px 0',
    fontSize: 12,
    color: isError ? 'var(--sf-error-ink)' : 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
    lineHeight: 1.4,
  };
  const iconSpan: CSSProperties = {
    width: 14,
    flexShrink: 0,
    textAlign: 'center',
    animation:
      running && !isFinish ? 'sf-pulse 1.5s ease-in-out infinite' : undefined,
  };
  const subSpan: CSSProperties = {
    color: 'var(--sf-fg-4)',
    marginLeft: 4,
  };

  return (
    <div style={row}>
      <span style={iconSpan}>{icon}</span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {label.headline}
        {label.sub && (
          <span style={subSpan}>· {label.sub.slice(-60)}</span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

interface DerivedState {
  hasDispatch: boolean;
  isStreaming: boolean;
  /** Non-delta events to show as activity lines. */
  activityEvents: ActivityEvent[];
}

function deriveState(events: ActivityEvent[]): DerivedState {
  let hasDispatch = false;
  let hasFinish = false;
  const activityEvents: ActivityEvent[] = [];

  for (const e of events) {
    if (e.kind === 'subagent_dispatch') {
      hasDispatch = true;
      activityEvents.push(e);
    } else if (e.kind === 'subagent_finish') {
      hasFinish = true;
      activityEvents.push(e);
    } else if (e.kind === 'tool_call_start' || e.kind === 'tool_call_finish') {
      activityEvents.push(e);
    } else if (
      e.kind === 'subagent_tool_call_start' ||
      e.kind === 'subagent_tool_call_finish'
    ) {
      activityEvents.push(e);
    }
    // subagent_text_delta: skip (raw JSON, not human-readable)
    // turn_start / turn_finish: skip (not relevant to onboarding)
  }

  return {
    hasDispatch,
    isStreaming: hasDispatch && !hasFinish,
    activityEvents,
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PlanBuildActivity({ runId }: PlanBuildActivityProps) {
  const { events, connectionError } = useCmoActivity({ runId });

  const { hasDispatch, isStreaming, activityEvents } = useMemo(
    () => deriveState(events),
    [events],
  );

  if (connectionError) {
    return (
      <div
        style={{
          padding: '14px 16px',
          background: 'var(--sf-error-light)',
          border: '1px solid var(--sf-border)',
          borderRadius: 10,
          fontSize: 13,
          color: 'var(--sf-error-ink)',
          letterSpacing: '-0.16px',
        }}
      >
        Couldn&apos;t connect to the activity feed. The strategist is still
        working — you&apos;ll advance automatically when the plan is ready.
      </div>
    );
  }

  // ---- Pre-events: typing-indicator-style placeholder ----
  if (!hasDispatch) {
    const wrap: CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 4px',
    };
    const bubble: CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '10px 14px',
      background: 'var(--sf-bg-secondary)',
      border: '1px solid var(--sf-border)',
      borderRadius: '14px 14px 14px 4px',
      boxShadow: 'var(--sf-shadow-card)',
    };
    const dotStyle = (delay: string): CSSProperties => ({
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: 'var(--sf-fg-3)',
      animation: `sf-typing-bounce 1.1s ease-in-out ${delay} infinite`,
    });
    const lbl: CSSProperties = {
      fontSize: 12,
      fontFamily: 'var(--sf-font-mono)',
      color: 'var(--sf-fg-3)',
      marginLeft: 4,
      letterSpacing: 0.3,
    };
    return (
      <div style={wrap} aria-label="CMO is thinking">
        <CmoDot />
        <div style={bubble}>
          <span style={dotStyle('0ms')} />
          <span style={dotStyle('150ms')} />
          <span style={dotStyle('300ms')} />
          <span style={lbl}>CMO is thinking…</span>
        </div>
        <style>{`
          @keyframes sf-typing-bounce {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30%            { transform: translateY(-3px); opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  // ---- Main card: CMO bubble + inline activity rows ----
  const statusText = isStreaming
    ? 'Building your growth strategy…'
    : 'Your strategic plan is ready.';

  return (
    <div style={CARD}>
      <div style={SCROLL}>
        <div style={MSG_ROW} role="article" aria-label="CMO is building your plan">
          <CmoDot pulse={isStreaming} />
          <div style={MSG_BODY}>
            {/* Name header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
              }}
            >
              <span
                style={{
                  fontWeight: 500,
                  color: 'var(--sf-fg-1)',
                  letterSpacing: '-0.01em',
                }}
              >
                CMO
              </span>
            </div>

            {/* Status message */}
            <div
              style={{
                fontSize: 14,
                color: 'var(--sf-fg-1)',
                lineHeight: 1.55,
              }}
            >
              {statusText}
              {isStreaming && <StreamingDots />}
            </div>

            {/* Activity lines */}
            {activityEvents.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {activityEvents.map((e, i) => (
                  <ActivityLine
                    key={e.id}
                    event={e}
                    running={
                      isStreaming && i === activityEvents.length - 1
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
