// OnbInput — 48px tall, radius 11, focus shows 1px accent border + 3px glow ring.
// Matches primitives.jsx OnbInput exactly.

import {
  forwardRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

export interface OnbInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  invalid?: boolean;
  rightSlot?: ReactNode;
  containerStyle?: CSSProperties;
  style?: CSSProperties;
}

export const OnbInput = forwardRef<HTMLInputElement, OnbInputProps>(
  function OnbInput(
    {
      invalid,
      rightSlot,
      containerStyle,
      style,
      onFocus,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const [focused, setFocused] = useState(false);
    const borderColor = invalid
      ? 'var(--sf-error)'
      : focused
        ? 'var(--sf-accent)'
        : 'rgba(0,0,0,0.12)';
    return (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          background: '#fff',
          border: `1px solid ${borderColor}`,
          borderRadius: 11,
          boxShadow: focused ? 'var(--sf-shadow-focus)' : 'none',
          transition: 'box-shadow 150ms, border-color 150ms',
          ...containerStyle,
        }}
      >
        <input
          ref={ref}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: 48,
            padding: '0 16px',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: 16,
            letterSpacing: '-0.224px',
            color: 'var(--sf-fg-1)',
            ...style,
          }}
          {...rest}
        />
        {rightSlot}
      </div>
    );
  },
);
