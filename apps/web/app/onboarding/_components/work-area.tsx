// WorkArea — scrollable right column that hosts each stage's content.
// Max-width 600 (desktop) / 340 (mobile). Entrance = sf-slide-up 400ms swift.

import type { ReactNode } from 'react';

interface WorkAreaProps {
  children: ReactNode;
  maxWidth?: number;
  /** Key used to re-trigger the entrance animation on stage change. */
  animationKey?: string | number;
}

export function WorkArea({
  children,
  maxWidth = 600,
  animationKey,
}: WorkAreaProps) {
  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--sf-bg-primary)',
        position: 'relative',
        overflowY: 'auto',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '72px 40px 60px',
      }}
    >
      <div
        key={animationKey}
        style={{
          width: '100%',
          maxWidth,
          animation: 'sf-slide-up 400ms cubic-bezier(0.16,1,0.3,1) both',
        }}
      >
        {children}
      </div>
    </main>
  );
}
