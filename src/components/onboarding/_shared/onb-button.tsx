// OnbButton — 3 sizes × 5 variants per frontend spec §11 + handoff primitives.jsx.
// `lg` is the onboarding-signature 44px capsule (radius 980px). Primary bg uses
// --sf-accent with hover --sf-accent-hover. Inline styles so the pixel values
// are traceable to the spec.

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';

export type OnbButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'dark'
  | 'darkGhost';

export type OnbButtonSize = 'sm' | 'md' | 'lg';

export interface OnbButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: OnbButtonVariant;
  size?: OnbButtonSize;
  children: ReactNode;
  style?: CSSProperties;
}

const BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  border: 'none',
  fontFamily: 'inherit',
  transition:
    'background 200ms cubic-bezier(0.16,1,0.3,1), color 200ms cubic-bezier(0.16,1,0.3,1), filter 150ms',
  whiteSpace: 'nowrap',
};

const SIZES: Record<OnbButtonSize, CSSProperties> = {
  lg: {
    height: 44,
    padding: '0 22px',
    borderRadius: 980,
    fontSize: 15,
    letterSpacing: '-0.224px',
    fontWeight: 400,
  },
  md: {
    height: 36,
    padding: '0 16px',
    borderRadius: 8,
    fontSize: 14,
    letterSpacing: '-0.224px',
    fontWeight: 400,
  },
  sm: {
    height: 28,
    padding: '0 10px',
    borderRadius: 6,
    fontSize: 12,
    letterSpacing: '-0.12px',
    fontWeight: 500,
  },
};

const VARIANTS: Record<OnbButtonVariant, CSSProperties> = {
  primary: { background: 'var(--sf-accent)', color: '#fff' },
  secondary: { background: 'rgba(0,0,0,0.05)', color: 'var(--sf-fg-1)' },
  ghost: { background: 'transparent', color: 'var(--sf-fg-3)' },
  dark: { background: '#fff', color: 'var(--sf-fg-1)' },
  darkGhost: {
    background: 'transparent',
    color: 'var(--sf-fg-on-dark-2)',
  },
};

export const OnbButton = forwardRef<HTMLButtonElement, OnbButtonProps>(
  function OnbButton(
    {
      variant = 'primary',
      size = 'md',
      disabled,
      children,
      style,
      onMouseEnter,
      onMouseLeave,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    const merged: CSSProperties = {
      ...BASE,
      ...SIZES[size],
      ...VARIANTS[variant],
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
      ...style,
    };
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        style={merged}
        onMouseEnter={(event) => {
          if (!disabled && variant === 'primary') {
            event.currentTarget.style.background = 'var(--sf-accent-hover)';
          }
          if (!disabled && variant === 'secondary') {
            event.currentTarget.style.background = 'rgba(0,0,0,0.08)';
          }
          if (!disabled && variant === 'ghost') {
            event.currentTarget.style.background = 'rgba(0,0,0,0.04)';
            event.currentTarget.style.color = 'var(--sf-fg-1)';
          }
          if (!disabled && variant === 'darkGhost') {
            event.currentTarget.style.background = 'rgba(255,255,255,0.06)';
            event.currentTarget.style.color = 'var(--sf-fg-on-dark-1)';
          }
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          if (!disabled && variant === 'primary') {
            event.currentTarget.style.background = 'var(--sf-accent)';
          }
          if (!disabled && variant === 'secondary') {
            event.currentTarget.style.background = 'rgba(0,0,0,0.05)';
          }
          if (!disabled && variant === 'ghost') {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = 'var(--sf-fg-3)';
          }
          if (!disabled && variant === 'darkGhost') {
            event.currentTarget.style.background = 'transparent';
            event.currentTarget.style.color = 'var(--sf-fg-on-dark-2)';
          }
          onMouseLeave?.(event);
        }}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
