import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

export type BadgeVariant =
  | 'default'
  | 'signal'
  | 'flare'
  | 'success'
  | 'warning'
  | 'danger';

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'style'> {
  variant?: BadgeVariant;
  mono?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}

const VARIANTS: Record<BadgeVariant, { bg: string; fg: string }> = {
  default: { bg: 'var(--sf-paper-sunken)', fg: 'var(--sf-fg-2)' },
  signal: { bg: 'var(--sf-signal-tint)', fg: 'var(--sf-signal-ink)' },
  flare: { bg: 'var(--sf-flare-tint)', fg: 'var(--sf-flare-ink)' },
  success: { bg: 'var(--sf-success-tint)', fg: 'var(--sf-success-ink)' },
  warning: { bg: 'var(--sf-warning-tint)', fg: 'var(--sf-warning-ink)' },
  danger: { bg: 'var(--sf-danger-tint)', fg: 'var(--sf-danger-ink)' },
};

/**
 * 22-tall tinted pill. Use `mono` for numeric / identifier content.
 */
export function Badge({
  variant = 'default',
  mono,
  children,
  className = '',
  style: styleOverride,
  ...rest
}: BadgeProps) {
  const tokens = VARIANTS[variant];
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    height: 22,
    padding: '0 8px',
    borderRadius: 'var(--sf-radius-sm)',
    background: tokens.bg,
    color: tokens.fg,
    fontSize: 'var(--sf-text-xs)',
    fontWeight: 500,
    letterSpacing: 'var(--sf-track-normal)',
    fontFamily: mono ? 'var(--sf-font-mono)' : 'inherit',
    fontVariantNumeric: mono ? 'tabular-nums' : 'normal',
    ...styleOverride,
  };
  return (
    <span className={className} style={style} {...rest}>
      {children}
    </span>
  );
}
