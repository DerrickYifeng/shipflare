// ScanDot — 22×22 status circle used in scanning + plan-building rows.
// States: pending (hollow) / active (filled + inner pulse) / done (filled + check).

import { Check } from '../icons';

export type ScanDotState = 'pending' | 'active' | 'done';

interface ScanDotProps {
  state: ScanDotState;
}

export function ScanDot({ state }: ScanDotProps) {
  if (state === 'done') {
    return (
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--sf-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <Check size={12} />
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--sf-accent-glow)',
          border: '1.5px solid var(--sf-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--sf-accent)',
            animation: 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
          }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        border: '1.5px solid rgba(0,0,0,0.16)',
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}
