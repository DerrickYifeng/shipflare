import type { ReactNode } from 'react';
import { Ops } from '@/components/ui/ops';

export interface SectionBarProps {
  /** Uppercase mono label — appears left of the divider. */
  children: ReactNode;
  /** Optional right-aligned count string. */
  count?: ReactNode;
}

/**
 * Section header: mono-uppercase label, horizontal rule to the right,
 * optional right-aligned mono count. Matches handoff pages.jsx `SectionBar`.
 */
export function SectionBar({ children, count }: SectionBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '24px 0 12px',
      }}
    >
      <Ops>{children}</Ops>
      <div style={{ flex: 1, height: 1, background: 'var(--sf-border-subtle)' }} />
      {count !== undefined && (
        <span
          className="sf-mono"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
            letterSpacing: 'var(--sf-track-mono)',
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}
