// StatePill — tiny capsule for connection status (Connected / Connecting / Error).

import type { ReactNode } from 'react';

interface StatePillProps {
  color: string;
  background: string;
  children: ReactNode;
}

export function StatePill({ color, background, children }: StatePillProps) {
  return (
    <span
      style={{
        padding: '2px 8px',
        borderRadius: 980,
        background,
        color,
        fontSize: 10,
        fontFamily: 'var(--sf-font-mono)',
        letterSpacing: '-0.08px',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}
