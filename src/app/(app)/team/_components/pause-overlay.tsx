'use client';

/**
 * `PauseOverlay` — per INTERACTIONS.md §9.
 *
 * When the office scene is paused, an ink-tinted semi-transparent overlay
 * lands over the scene with a "PAUSED · CLICK TO RESUME" label. Clicking
 * anywhere on the overlay releases the pause.
 *
 * The overlay is only rendered while `paused === true` — unmounting (rather
 * than hiding) guarantees that any transforms / animations underneath resume
 * from a clean slate.
 *
 * Motion: a single compositor-friendly `opacity` fade-in via the shared
 * `sf-fade-in` keyframe. Reduced motion is honored globally via
 * `prefers-reduced-motion` in `globals.css`.
 */

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Ops } from '@/components/ui/ops';

export interface PauseOverlayProps {
  /** Fires when the user clicks the overlay or presses Enter / Space on it. */
  onResume: () => void;
}

export function PauseOverlay({ onResume }: PauseOverlayProps) {
  const handleKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onResume();
    }
  };

  return (
    <button
      type="button"
      onClick={onResume}
      onKeyDown={handleKey}
      aria-label="Paused. Click to resume."
      style={OVERLAY_STYLE}
    >
      <div style={LABEL_STYLE}>
        <Ops tone="onDark" style={{ fontSize: 'var(--sf-text-sm)' }}>
          PAUSED · CLICK TO RESUME
        </Ops>
      </div>
    </button>
  );
}

const OVERLAY_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  border: 'none',
  cursor: 'pointer',
  background: 'oklch(14% 0.020 265 / 0.55)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  borderRadius: 'var(--sf-radius-lg)',
  animation: 'sf-fade-in var(--sf-dur-base) var(--sf-ease-swift) forwards',
  font: 'inherit',
};

const LABEL_STYLE: CSSProperties = {
  padding: '10px 18px',
  borderRadius: 'var(--sf-radius-pill)',
  background: 'oklch(14% 0.020 265 / 0.85)',
  border: '1px solid var(--sf-border-on-dark)',
  boxShadow: 'var(--sf-shadow-md)',
};
