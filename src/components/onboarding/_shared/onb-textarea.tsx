// OnbTextarea — same focus treatment as OnbInput; `resize: vertical`.

import {
  forwardRef,
  useState,
  type CSSProperties,
  type TextareaHTMLAttributes,
} from 'react';

export interface OnbTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  invalid?: boolean;
  containerStyle?: CSSProperties;
  style?: CSSProperties;
}

export const OnbTextarea = forwardRef<HTMLTextAreaElement, OnbTextareaProps>(
  function OnbTextarea(
    { invalid, containerStyle, style, onFocus, onBlur, rows = 4, ...rest },
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
          background: '#fff',
          border: `1px solid ${borderColor}`,
          borderRadius: 11,
          boxShadow: focused ? 'var(--sf-shadow-focus)' : 'none',
          transition: 'box-shadow 150ms, border-color 150ms',
          ...containerStyle,
        }}
      >
        <textarea
          ref={ref}
          rows={rows}
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
            padding: '12px 16px',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: 16,
            letterSpacing: '-0.224px',
            lineHeight: 1.47,
            color: 'var(--sf-fg-1)',
            resize: 'vertical',
            ...style,
          }}
          {...rest}
        />
      </div>
    );
  },
);
