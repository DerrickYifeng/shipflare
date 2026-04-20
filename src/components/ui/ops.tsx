import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export type OpsTone =
  | 'dim'
  | 'ink'
  | 'signal'
  | 'flare'
  | 'success'
  | 'warning'
  | 'danger'
  | 'onDark';

export interface OpsProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'style'> {
  tone?: OpsTone;
  children: ReactNode;
  style?: CSSProperties;
}

const TONE_COLORS: Record<OpsTone, string> = {
  dim: 'var(--sf-fg-3)',
  ink: 'var(--sf-fg-1)',
  signal: 'var(--sf-link)',
  flare: 'var(--sf-link)',
  success: 'var(--sf-success-ink)',
  warning: 'var(--sf-warning-ink)',
  danger: 'var(--sf-error-ink)',
  onDark: 'var(--sf-fg-on-dark-3)',
};

/**
 * SIGNATURE label — mono uppercase, 12px, tracked 0.02em, tabular-nums.
 * Relies on the globally-defined `.sf-ops` class from globals.css.
 */
export function Ops({
  tone = 'dim',
  children,
  className = '',
  style: styleOverride,
  ...rest
}: OpsProps) {
  const style: CSSProperties = {
    color: TONE_COLORS[tone],
    ...styleOverride,
  };
  return (
    <span className={`sf-ops ${className}`.trim()} style={style} {...rest}>
      {children}
    </span>
  );
}
