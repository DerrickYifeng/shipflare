'use client';

/**
 * ShipFlare v2 — NewCardReveal
 *
 * Wraps a card to stagger-slide it on first entry when `isNew` is true.
 * Used by Today to animate freshly-drafted replies arriving after a
 * cinematic scan. Ports `NewCardReveal` from the design handoff's
 * `source/app/motion.jsx` — shared so Office can reuse it later.
 *
 * Compositor-friendly motion: transform + opacity only.
 */

import { type ReactNode, useEffect, useState } from 'react';

export interface NewCardRevealProps {
  children: ReactNode;
  /** Delay before the reveal animation fires (ms). */
  delay?: number;
  /** Only animate when this card was actually added by the latest scan. */
  isNew?: boolean;
}

export function NewCardReveal({
  children,
  delay = 0,
  isNew = false,
}: NewCardRevealProps) {
  const [shown, setShown] = useState(!isNew);

  useEffect(() => {
    if (!isNew) return;
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [isNew, delay]);

  return (
    <div
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0)' : 'translateY(12px)',
        transition:
          'opacity 420ms var(--sf-ease-swift), transform 420ms var(--sf-ease-swift)',
      }}
    >
      {children}
    </div>
  );
}
