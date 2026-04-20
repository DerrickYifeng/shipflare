'use client';

import { useState, type ButtonHTMLAttributes, type CSSProperties } from 'react';

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'style'> {
  /** Controlled on/off state. If provided alongside `onChange`, the parent owns state. */
  checked?: boolean;
  /** Uncontrolled initial state. Ignored when `checked` is provided. */
  defaultChecked?: boolean;
  /** Fired after the user toggles — receives the NEW value. */
  onChange?: (next: boolean) => void;
  /** Accessible label describing what the switch controls. */
  'aria-label'?: string;
  style?: CSSProperties;
}

/**
 * Boolean switch (iOS-style 36×20 pill with animated thumb).
 *
 * Matches handoff pages.jsx `Toggle`. Named `Switch` here because the existing
 * `src/components/ui/toggle.tsx` is a disclosure widget with the same name —
 * we preserve both primitives rather than collide.
 */
export function Switch({
  checked,
  defaultChecked = false,
  onChange,
  disabled,
  className = '',
  style: styleOverride,
  ...rest
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? (checked as boolean) : internal;

  const style: CSSProperties = {
    width: 36,
    height: 20,
    borderRadius: 10,
    border: 'none',
    background: on ? 'var(--sf-accent)' : 'var(--sf-bg-tertiary)',
    position: 'relative',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
    padding: 0,
    fontFamily: 'inherit',
    flexShrink: 0,
    opacity: disabled ? 0.5 : 1,
    ...styleOverride,
  };

  const thumb: CSSProperties = {
    position: 'absolute',
    top: 2,
    left: on ? 18 : 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    background: '#fff',
    boxShadow: '0 1px 2px oklch(20% 0 0 / 0.2)',
    transition: 'left var(--sf-dur-base) var(--sf-ease-swift)',
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={className}
      style={style}
      onClick={(event) => {
        if (disabled) return;
        const next = !on;
        if (!isControlled) setInternal(next);
        onChange?.(next);
        rest.onClick?.(event);
      }}
      {...rest}
    >
      <span style={thumb} />
    </button>
  );
}
