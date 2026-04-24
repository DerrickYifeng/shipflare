import type { CSSProperties, ReactNode } from 'react';

// Labels derived client-side from the conversation flow:
//   - a lead message followed by ≥2 Task tool_calls → PARALLEL DISPATCH
//   - exactly 1 Task                                → DISPATCH
//   - lead text after all downstream tasks done     → SYNTHESIS
//   - team_messages.type === 'completion'           → DONE
//   - anything else                                 → PLAN
//
// The reducer is where the derivation actually happens (see
// `conversation-reducer.ts`) — this component is the visual.
export type Phase =
  | 'PLAN'
  | 'DISPATCH'
  | 'PARALLEL DISPATCH'
  | 'SYNTHESIS'
  | 'DONE'
  | 'REVIEW';

export interface PhaseTagProps {
  phase: Phase;
  /** Optional slot that renders to the right of the label (e.g. count). */
  trailing?: ReactNode;
}

// Tones kept aligned with the existing status-tone palette so PLAN/DISPATCH
// feel related to the "running" accent and DONE reads as a terminal success.
function toneFor(phase: Phase): { fg: string; bg: string } {
  switch (phase) {
    case 'PARALLEL DISPATCH':
    case 'DISPATCH':
      return {
        fg: 'var(--sf-accent)',
        bg: 'color-mix(in oklch, var(--sf-accent) 12%, transparent)',
      };
    case 'SYNTHESIS':
    case 'REVIEW':
      return {
        fg: 'var(--sf-warning-ink)',
        bg: 'color-mix(in oklch, var(--sf-warning) 18%, transparent)',
      };
    case 'DONE':
      return {
        fg: 'var(--sf-success-ink)',
        bg: 'color-mix(in oklch, var(--sf-success) 18%, transparent)',
      };
    case 'PLAN':
    default:
      return {
        fg: 'var(--sf-fg-2)',
        bg: 'rgba(0, 0, 0, 0.05)',
      };
  }
}

export function PhaseTag({ phase, trailing }: PhaseTagProps) {
  const { fg, bg } = toneFor(phase);
  const wrap: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    borderRadius: 4,
    background: bg,
    color: fg,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
  return (
    <span style={wrap} data-testid="phase-tag" data-phase={phase}>
      <span>{phase}</span>
      {trailing}
    </span>
  );
}
