import type { ReactNode } from 'react';

export interface FieldRowProps {
  label: ReactNode;
  children: ReactNode;
  /** Dims the label for de-emphasized fields (e.g. "Delete account"). */
  muted?: boolean;
  /** Optional right-aligned action — e.g. a "Change" or "Edit" affordance. */
  action?: ReactNode;
}

/**
 * A single label/value row used across settings and product surfaces.
 * Two-column grid: 140–160px label, flex value, 1px subtle divider below.
 * Pixel reference: handoff pages.jsx `FieldRow`.
 */
export function FieldRow({ label, children, muted = false, action }: FieldRowProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 160px) 1fr auto',
        gap: 20,
        alignItems: 'baseline',
        padding: '12px 0',
        borderBottom: '1px solid var(--sf-border-subtle)',
      }}
    >
      <div
        style={{
          fontSize: 'var(--sf-text-sm)',
          fontWeight: 500,
          color: muted ? 'var(--sf-fg-3)' : 'var(--sf-fg-2)',
        }}
      >
        {label}
      </div>
      <div style={{ minWidth: 0, fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-1)' }}>
        {children}
      </div>
      {action ? <div style={{ justifySelf: 'end' }}>{action}</div> : <div />}
    </div>
  );
}
