import type { CSSProperties, ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Dashed paper-sunken block for empty lists / zero states.
 * Includes a small decorative dot on a raised circle above the title.
 */
export function EmptyState({ title, hint, action, className = '' }: EmptyStateProps) {
  const container: CSSProperties = {
    padding: '48px 32px',
    textAlign: 'center',
    background: 'var(--sf-bg-tertiary)',
    borderRadius: 'var(--sf-radius-lg)',
    border: '1px dashed var(--sf-border)',
  };
  const iconWrap: CSSProperties = {
    width: 40,
    height: 40,
    margin: '0 auto 16px',
    borderRadius: '50%',
    background: 'var(--sf-bg-secondary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const dot: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--sf-fg-4)',
  };
  const titleStyle: CSSProperties = {
    fontSize: 'var(--sf-text-base)',
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
  };
  const hintStyle: CSSProperties = {
    marginTop: 6,
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-3)',
  };
  return (
    <div className={className} style={container}>
      <div style={iconWrap}>
        <span style={dot} />
      </div>
      <div style={titleStyle}>{title}</div>
      {hint ? <div style={hintStyle}>{hint}</div> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}
