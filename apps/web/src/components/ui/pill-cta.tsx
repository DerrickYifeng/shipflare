'use client';

import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  forwardRef,
  useState,
} from 'react';

export interface PillCtaProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  children: ReactNode;
  style?: CSSProperties;
}

/**
 * Signature 48-tall capsule CTA with a trailing arrow glyph.
 * Reserved for hero-level CTAs (landing, onboarding completion).
 * Apple-Blue only — v3 has one chromatic.
 */
export const PillCta = forwardRef<HTMLButtonElement, PillCtaProps>(
  function PillCta(
    {
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
    const style: CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      height: 48,
      padding: '0 24px',
      background: hover ? 'var(--sf-accent-hover)' : 'var(--sf-accent)',
      color: 'var(--sf-fg-on-dark-1)',
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
