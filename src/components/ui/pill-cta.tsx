'use client';

import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  forwardRef,
  useState,
} from 'react';

export type PillCtaVariant = 'primary' | 'flare';

export interface PillCtaProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: PillCtaVariant;
  children: ReactNode;
  style?: CSSProperties;
}

const VARIANTS: Record<
  PillCtaVariant,
  { background: string; hover: string; color: string }
> = {
  primary: {
    background: 'var(--sf-signal)',
    hover: 'var(--sf-signal-hover)',
    color: 'var(--sf-fg-on-dark-1)',
  },
  flare: {
    background: 'var(--sf-flare)',
    hover: 'var(--sf-flare-hover)',
    color: 'var(--sf-ink)',
  },
};

/**
 * Signature 48-tall capsule CTA with a trailing arrow glyph.
 * Reserved for hero-level CTAs (landing, onboarding completion).
 */
export const PillCta = forwardRef<HTMLButtonElement, PillCtaProps>(
  function PillCta(
    {
      variant = 'primary',
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
    const tokens = VARIANTS[variant];
    const style: CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      height: 48,
      padding: '0 24px',
      background: hover ? tokens.hover : tokens.background,
      color: tokens.color,
      borderRadius: 'var(--sf-radius-pill)',
      border: 'none',
      cursor: 'pointer',
      fontSize: 'var(--sf-text-base)',
      fontWeight: 500,
      letterSpacing: 'var(--sf-track-normal)',
      fontFamily: 'inherit',
      transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
      ...styleOverride,
    };
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
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
        {children}
        <span style={{ fontSize: 16 }} aria-hidden="true">
          →
        </span>
      </button>
    );
  },
);
