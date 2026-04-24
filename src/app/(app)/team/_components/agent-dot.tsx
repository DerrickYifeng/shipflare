import type { CSSProperties } from 'react';

export interface AgentDotProps {
  /** Concrete color (hex or CSS var) used as the disc background. */
  color: string;
  /** Single-letter monogram shown inside the disc. */
  initial: string;
  /** Diameter in px. Designs use 18, 24, and 28. Defaults to 28. */
  size?: number;
  /** When true, animate the disc with the shared sf-pulse keyframe. */
  pulse?: boolean;
  /** When true, render a blue focus ring around the disc. */
  active?: boolean;
  /** Accessible label; defaults to hidden-from-AT since the monogram is decorative. */
  label?: string;
}

/**
 * Monogram disc used everywhere an agent is represented in the AI-team view:
 * left-rail rows, lead/user message avatars, delegation-card task rows,
 * and the agent-workspace header. The disc itself is the primary "brand
 * color" surface — when the plan says "agent color", this is where it
 * lives.
 */
export function AgentDot({
  color,
  initial,
  size = 28,
  pulse,
  active,
  label,
}: AgentDotProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: '50%',
    background: color,
    color: 'var(--sf-fg-on-dark-1)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--sf-font-display)',
    fontSize: Math.max(10, Math.round(size * 0.5)),
    fontWeight: 600,
    letterSpacing: 0.2,
    lineHeight: 1,
    userSelect: 'none',
    flexShrink: 0,
    boxShadow: active
      ? '0 0 0 2px var(--sf-bg-secondary), 0 0 0 4px rgba(0, 113, 227, 0.35)'
      : undefined,
    animation: pulse ? 'var(--animate-sf-pulse)' : undefined,
  };
  const ariaHidden = label ? undefined : true;
  return (
    <span
      style={style}
      aria-hidden={ariaHidden}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      {initial}
    </span>
  );
}
