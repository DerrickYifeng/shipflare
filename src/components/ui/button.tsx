'use client';

import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  forwardRef,
  useState,
} from 'react';

export type ButtonVariant = 'primary' | 'ghost' | 'ink' | 'error';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  block?: boolean;
  style?: CSSProperties;
}

type VariantTokens = {
  background: string;
  color: string;
  border: string;
  hoverBackground: string;
};

const VARIANT_TOKENS: Record<ButtonVariant, VariantTokens> = {
  primary: {
    background: 'var(--sf-accent)',
    color: 'var(--sf-fg-on-dark-1)',
    border: 'none',
    hoverBackground: 'var(--sf-accent-hover)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--sf-fg-1)',
    border: '1px solid var(--sf-border)',
    hoverBackground: 'var(--sf-bg-tertiary)',
  },
  ink: {
    background: 'var(--sf-bg-dark)',
    color: 'var(--sf-fg-on-dark-1)',
    border: 'none',
    hoverBackground: 'var(--sf-bg-dark-surface)',
  },
  error: {
    background: 'var(--sf-error)',
    color: 'var(--sf-fg-on-dark-1)',
    border: 'none',
    hoverBackground: 'var(--sf-error-ink)',
  },
};

const SIZE_METRICS: Record<ButtonSize, { height: number; padding: string; fontSize: string }> = {
  sm: { height: 32, padding: '0 12px', fontSize: 'var(--sf-text-sm)' },
  md: { height: 40, padding: '0 16px', fontSize: 'var(--sf-text-base)' },
  lg: { height: 48, padding: '0 24px', fontSize: 'var(--sf-text-base)' },
};

/**
 * ShipFlare v3 Button primitive.
 * Apple-Blue primary, monochrome ghost/ink, and error. No warm-accent (flare)
 * variant — Apple Blue is the one chromatic in v3.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      icon,
      block,
      disabled,
      children,
      onMouseEnter,
      onMouseLeave,
      style: styleOverride,
      type,
      className = '',
      ...rest
    },
    ref,
  ) {
    const [hover, setHover] = useState(false);
    const tokens = VARIANT_TOKENS[variant];
    const metrics = SIZE_METRICS[size];
    const style: CSSProperties = {
      display: block ? 'flex' : 'inline-flex',
      width: block ? '100%' : 'auto',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: metrics.height,
      padding: metrics.padding,
      borderRadius: 'var(--sf-radius-md)',
      fontSize: metrics.fontSize,
      fontWeight: 500,
      letterSpacing: 'var(--sf-track-normal)',
      fontFamily: 'inherit',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
      background: hover && !disabled ? tokens.hoverBackground : tokens.background,
      color: tokens.color,
      border: tokens.border,
      ...styleOverride,
    };
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        disabled={disabled}
        className={className}
        style={style}
        onMouseEnter={(event) => {
          setHover(true);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setHover(false);
          onMouseLeave?.(event);
        }}
        {...rest}
      >
        {icon}
        {children}
      </button>
    );
  },
);
