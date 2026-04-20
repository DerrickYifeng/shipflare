import type { CSSProperties } from 'react';

export type StatusDotState = 'active' | 'success' | 'warning' | 'danger' | 'idle';

export interface StatusDotProps {
  state?: StatusDotState;
  /** Diameter in pixels. Defaults to 8. */
  size?: number;
  className?: string;
  'aria-label'?: string;
}

const STATE_COLORS: Record<StatusDotState, string> = {
  active: 'var(--sf-accent)',
  success: 'var(--sf-success)',
  warning: 'var(--sf-warning)',
  danger: 'var(--sf-error)',
  idle: 'var(--sf-fg-4)',
};

/**
 * Small solid dot used in AgentCard, ThoughtStream, SourceChip, etc.
 * Pulses via the global `sf-pulse` keyframe when `state="active"`.
 */
export function StatusDot({
  state = 'active',
  size = 8,
  className = '',
  'aria-label': ariaLabel,
}: StatusDotProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: STATE_COLORS[state],
    display: 'inline-block',
    flexShrink: 0,
    animation: state === 'active' ? 'sf-pulse 1.5s ease-in-out infinite' : 'none',
  };
  return (
    <span
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
      className={className}
      style={style}
    />
  );
}
