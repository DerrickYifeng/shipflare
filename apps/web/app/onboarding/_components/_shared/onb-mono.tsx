// Signature mono-uppercase label (SF Mono 11 / tabular-nums / -0.08 tracking).
// This is the ShipFlare voice — used for kickers, status pills, agent names.

import type { CSSProperties, ReactNode } from 'react';

interface OnbMonoProps {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
  className?: string;
}

export function OnbMono({ children, color, style, className }: OnbMonoProps) {
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--sf-font-mono)',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '-0.08px',
        textTransform: 'uppercase',
        color: color ?? 'var(--sf-fg-4)',
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
