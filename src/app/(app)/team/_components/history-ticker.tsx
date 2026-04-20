/**
 * Dark-slate scrolling ticker under the scene — shows the last handful of
 * agent events (real tool calls, reviews, completions) streamed off the SSE
 * feed. When empty, shows a single "no activity" placeholder.
 *
 * The strip is duplicated so the 50% translate loop reads as continuous; the
 * `sf-ticker` keyframe lives in `globals.css`.
 */

import type { CSSProperties } from 'react';

export interface TickerEvent {
  /** Formatted local time — "14:21:42". */
  when: string;
  /** Agent display name. */
  agent: string;
  /** Short human action — "scanned r/SaaS · 38 candidates". */
  action: string;
}

export interface HistoryTickerProps {
  events: TickerEvent[];
}

const OUTER_STYLE: CSSProperties = {
  borderRadius: 'var(--sf-radius-md)',
  background: 'var(--sf-ink)',
  color: 'var(--sf-fg-on-dark-2)',
  padding: '10px 14px',
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 'var(--sf-text-xs)',
  letterSpacing: 'var(--sf-track-mono)',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  border: '1px solid var(--sf-border-on-dark)',
};

export function HistoryTicker({ events }: HistoryTickerProps) {
  if (events.length === 0) {
    return (
      <div style={OUTER_STYLE}>
        <span style={{ color: 'var(--sf-fg-on-dark-4)', flexShrink: 0, fontWeight: 600 }}>
          LIVE LOG
        </span>
        <span style={{ color: 'var(--sf-fg-on-dark-3)' }}>
          Waiting for the next scan…
        </span>
      </div>
    );
  }

  // Duplicate events so the 50% translate keyframe loops continuously.
  const strip = [...events, ...events];
  return (
    <div style={OUTER_STYLE}>
      <span
        style={{
          color: 'var(--sf-fg-on-dark-4)',
          flexShrink: 0,
          textTransform: 'uppercase',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        LIVE LOG
      </span>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div
          style={{
            display: 'inline-flex',
            gap: 32,
            whiteSpace: 'nowrap',
            animation: 'sf-ticker 40s linear infinite',
          }}
        >
          {strip.map((e, i) => (
            <span
              key={`${e.when}-${e.agent}-${i}`}
              style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}
            >
              <span style={{ color: 'var(--sf-fg-on-dark-4)' }}>{e.when}</span>
              <span style={{ color: 'var(--sf-fg-on-dark-1)' }}>{e.agent}</span>
              <span style={{ color: 'var(--sf-fg-on-dark-3)' }}>→</span>
              <span style={{ color: 'var(--sf-fg-on-dark-2)' }}>{e.action}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
