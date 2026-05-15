// StepHeader — kicker (mono) + title (34/600) + sub (16/400 rgba 0.64).
// Used at the top of every stage's WorkArea content.

import type { ReactNode } from 'react';
import { OnbMono } from './_shared/onb-mono';

interface StepHeaderProps {
  kicker: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
}

export function StepHeader({ kicker, title, sub }: StepHeaderProps) {
  return (
    <div style={{ marginBottom: 24 }}>
      <OnbMono>{kicker}</OnbMono>
      <h2
        style={{
          margin: '12px 0 8px',
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.12,
          letterSpacing: '-0.28px',
          color: 'var(--sf-fg-1)',
        }}
      >
        {title}
      </h2>
      {sub && (
        <p
          style={{
            margin: 0,
            fontSize: 15,
            lineHeight: 1.47,
            letterSpacing: '-0.224px',
            color: 'var(--sf-fg-2)',
          }}
        >
          {sub}
        </p>
      )}
    </div>
  );
}
