// FieldReveal — opacity + translateY stagger wrapper.
// Used in stage 3 review; consumers flip `shown` on mount to trigger reveal.

import type { CSSProperties, ReactNode } from 'react';

interface FieldRevealProps {
  shown: boolean;
  delay?: number;
  children: ReactNode;
  style?: CSSProperties;
}

export function FieldReveal({
  shown,
  delay = 0,
  children,
  style,
}: FieldRevealProps) {
  return (
    <div
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(4px)',
        transition:
          'opacity 280ms cubic-bezier(0.16,1,0.3,1), transform 280ms cubic-bezier(0.16,1,0.3,1)',
        transitionDelay: `${delay}ms`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
