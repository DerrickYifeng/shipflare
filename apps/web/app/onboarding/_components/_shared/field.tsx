// Field — label + child input + hint/error. Used in Stage 3 review.

import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: FieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-1)',
        }}
      >
        {label}
        {required && <span style={{ color: 'var(--sf-fg-4)' }}> *</span>}
      </label>
      {children}
      {error && (
        <div
          role="alert"
          style={{
            fontSize: 12,
            color: 'var(--sf-error-ink)',
            letterSpacing: '-0.12px',
          }}
        >
          {error}
        </div>
      )}
      {hint && !error && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--sf-fg-4)',
            letterSpacing: '-0.12px',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
