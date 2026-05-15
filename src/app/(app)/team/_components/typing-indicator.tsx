'use client';

import { type CSSProperties } from 'react';

export interface TypingIndicatorProps {
  /**
   * Unused — kept on the prop type so existing call sites (which pass
   * 'dispatching' between text_stop and the subagent's first event)
   * compile unchanged. The dots-only design is intentionally
   * label-free + counter-free; ambient quiet beat the labelled verb +
   * elapsed counter after the latter felt noisy in the kickoff stream.
   */
  label?: string;
}

/**
 * Three bouncing dots, pinned below the thread while any agent_run is
 * non-terminal. No verb, no elapsed counter — the dots' own animation
 * is the entire signal. Trades information for calm.
 */
export function TypingIndicator(_props: TypingIndicatorProps = {}) {
  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 0 14px 38px',
  };

  const dot: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--sf-fg-3)',
    animation: 'var(--animate-sf-pulse)',
  };

  return (
    <div
      style={row}
      data-testid="typing-indicator"
      aria-live="polite"
      aria-label="Team Lead is working"
    >
      <span style={{ ...dot, animationDelay: '0ms' }} aria-hidden="true" />
      <span style={{ ...dot, animationDelay: '180ms' }} aria-hidden="true" />
      <span style={{ ...dot, animationDelay: '360ms' }} aria-hidden="true" />
    </div>
  );
}
