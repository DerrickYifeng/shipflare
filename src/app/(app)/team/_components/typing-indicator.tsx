'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

export interface TypingIndicatorProps {
  /**
   * Optional explicit label. Defaults to "working". Falls back to the
   * default when omitted — e.g. the coordinator turn between text_stop
   * and the subagent's first event can pass "dispatching" here.
   */
  label?: string;
}

/**
 * Three bouncing dots + a ticking elapsed counter, pinned below the
 * thread while a run is live but the current turn hasn't produced a
 * visible output yet. The counter is the important detail — without it
 * the user can't tell a 2s spawn from a 20s stall. Claude Code takes
 * the same tack (engine/screens/REPL.tsx's spinner shows elapsed
 * seconds alongside the status verb).
 *
 * The timer starts on mount; when the parent hides the indicator (run
 * finished, stream resumed, etc.) the component unmounts and the
 * counter resets — exactly the behavior we want, no manual reset.
 */
export function TypingIndicator({ label = 'working' }: TypingIndicatorProps = {}) {
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    startedAtRef.current = Date.now();
    // Tick once per second — fine-grained enough for human perception,
    // coarse enough not to thrash layout. Cleared on unmount.
    const interval = setInterval(() => {
      setElapsedSeconds(
        Math.floor((Date.now() - (startedAtRef.current ?? Date.now())) / 1000),
      );
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 0 14px 38px',
  };

  const dot: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--sf-fg-3)',
    animation: 'var(--animate-sf-pulse)',
  };

  const labelStyle: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  const elapsedStyle: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
  };

  // Hide the counter for the first second — showing "0s" feels buggy,
  // and the dots' own animation is enough to read as "working" until
  // the first tick lands.
  const shouldShowElapsed = elapsedSeconds >= 1;

  return (
    <div
      style={row}
      data-testid="typing-indicator"
      aria-live="polite"
      aria-label={`Team Lead is ${label}`}
    >
      <span style={{ ...dot, animationDelay: '0ms' }} aria-hidden="true" />
      <span style={{ ...dot, animationDelay: '180ms' }} aria-hidden="true" />
      <span style={{ ...dot, animationDelay: '360ms' }} aria-hidden="true" />
      <span style={labelStyle}>{label}…</span>
      {shouldShowElapsed ? (
        <span style={elapsedStyle}>· {elapsedSeconds}s</span>
      ) : null}
    </div>
  );
}
