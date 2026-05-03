import type { CSSProperties } from 'react';

// Status enum for an `agent_runs` row's lifecycle position. Mirrors the
// runtime states the workers transition through (see
// `src/workers/processors/agent-run.ts`):
//
//   sleeping  — row exists but no work is in flight (default for new rows)
//   queued    — picked up by the scheduler, waiting for a worker slot
//   running   — actively processing turns
//   resuming  — waking from a paused state (notification arrived in mailbox)
//   completed — terminal: success
//   failed    — terminal: thrown error or exhausted retries
//   killed    — terminal: cancelled by user / cap exceeded
export type AgentStatus =
  | 'sleeping'
  | 'queued'
  | 'running'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'killed';

export interface AgentStatusPillProps {
  status: AgentStatus;
  /** Optional override for the visible text. Defaults to the status name. */
  label?: string;
}

interface Tone {
  fg: string;
  bg: string;
}

// Palette mapped to the existing `--sf-*` design tokens used elsewhere in
// the team UI (see `phase-tag.tsx` and `status-banner.tsx`). We avoid
// introducing the spec's literal Tailwind classes (`bg-gray-100` etc.)
// because the rest of `team/_components/` renders with inline styles and
// design tokens, not utility classes.
function toneFor(status: AgentStatus): Tone {
  switch (status) {
    case 'sleeping':
      return {
        fg: 'var(--sf-fg-3)',
        bg: 'rgba(0, 0, 0, 0.05)',
      };
    case 'queued':
      return {
        fg: 'var(--sf-warning-ink)',
        bg: 'var(--sf-warning-light)',
      };
    case 'running':
      return {
        fg: 'var(--sf-accent)',
        bg: 'var(--sf-accent-light)',
      };
    case 'resuming':
      return {
        fg: 'var(--sf-warning-ink)',
        bg: 'color-mix(in oklch, var(--sf-warning) 22%, transparent)',
      };
    case 'completed':
      return {
        fg: 'var(--sf-success-ink)',
        bg: 'var(--sf-success-light)',
      };
    case 'failed':
      return {
        fg: 'var(--sf-error-ink)',
        bg: 'var(--sf-error-light)',
      };
    case 'killed':
      return {
        fg: 'var(--sf-fg-on-dark-1)',
        bg: 'var(--sf-error)',
      };
  }
}

const ICONS: Record<AgentStatus, string> = {
  sleeping: 'zZz',
  queued: '●',
  running: '⟳',
  resuming: '⟳',
  completed: '✓',
  failed: '✗',
  killed: '🛑',
};

// Status families that animate. `running` and `resuming` spin the glyph
// continuously; `queued` softly pulses the whole pill to telegraph "waiting".
function isSpinning(status: AgentStatus): boolean {
  return status === 'running' || status === 'resuming';
}

function isPulsing(status: AgentStatus): boolean {
  return status === 'queued';
}

/**
 * Compact pill that renders an `agent_runs` row's lifecycle state with a
 * status glyph, color tone, and optional motion. Reused everywhere we
 * surface an agent's current position — teammate roster, task notification
 * cards, transcript drawer headers, etc.
 *
 * Pure presentation: no data fetching, no live subscription. The caller is
 * responsible for re-rendering with a fresh `status` prop when the
 * underlying `agent_runs` row transitions.
 */
export function AgentStatusPill({ status, label }: AgentStatusPillProps) {
  const tone = toneFor(status);
  const wrap: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    borderRadius: 999,
    background: tone.bg,
    color: tone.fg,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    animation: isPulsing(status) ? 'var(--animate-sf-pulse)' : undefined,
  };
  const glyph: CSSProperties = {
    display: 'inline-block',
    fontSize: 12,
    lineHeight: 1,
    animation: isSpinning(status)
      ? 'var(--animate-sf-status-spin)'
      : undefined,
  };
  const text = label ?? status;
  return (
    <span
      style={wrap}
      data-testid="agent-status-pill"
      data-status={status}
      role="status"
      aria-label={`Agent ${status}`}
    >
      <span style={glyph} aria-hidden="true">
        {ICONS[status]}
      </span>
      <span>{text}</span>
    </span>
  );
}
