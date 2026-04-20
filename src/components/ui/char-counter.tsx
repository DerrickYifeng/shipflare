import type { CSSProperties } from 'react';

export interface CharCounterProps {
  count: number;
  max: number;
  className?: string;
}

/**
 * Signature mono ratio counter — shifts to warning at >90% and danger at >100%.
 */
export function CharCounter({ count, max, className = '' }: CharCounterProps) {
  const over = count > max;
  const near = count > max * 0.9;
  const color = over
    ? 'var(--sf-danger-ink)'
    : near
      ? 'var(--sf-warning-ink)'
      : 'var(--sf-fg-3)';
  const style: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color,
    letterSpacing: 'var(--sf-track-mono)',
  };
  return (
    <span className={`sf-mono ${className}`.trim()} style={style}>
      {count}/{max}
    </span>
  );
}
