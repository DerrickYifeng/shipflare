/**
 * Tiny SVG character — 20×36 at size=1, feet anchored at (0,0).
 * Mirrors the hand-off prototype `TinyCharacter` in `office.jsx`.
 * The "hue" paints the torso so each agent reads as a distinct figure.
 */

import type { CSSProperties } from 'react';

export interface TinyCharacterProps {
  /** OKLCH color string painted on the torso. */
  hue: string;
  /** When true, the legs rotate via the `sf-walk` keyframe. */
  walking?: boolean;
  /** Uniform scale multiplier. Default 1 = 20×36px. */
  size?: number;
}

const WRAPPER_STYLE: CSSProperties = {
  display: 'block',
  overflow: 'visible',
};

export function TinyCharacter({ hue, walking = false, size = 1 }: TinyCharacterProps) {
  const w = 20 * size;
  const h = 36 * size;
  const legStyle: CSSProperties = {
    transformOrigin: '0 -6px',
    animation: walking ? 'sf-walk 0.36s ease-in-out infinite' : 'none',
  };
  return (
    <svg
      width={w}
      height={h}
      viewBox="-10 -36 20 36"
      aria-hidden="true"
      style={WRAPPER_STYLE}
    >
      {/* Shadow under the feet */}
      <ellipse cx="0" cy="0" rx="8" ry="2" fill="oklch(20% 0 0 / 0.25)" />

      {/* Legs — subtle walk cycle */}
      <g style={legStyle}>
        <rect x="-4" y="-14" width="3" height="10" rx="1" fill="oklch(28% 0.01 260)" />
        <rect x="1" y="-14" width="3" height="10" rx="1" fill="oklch(28% 0.01 260)" />
      </g>

      {/* Torso — agent hue */}
      <rect x="-6" y="-26" width="12" height="14" rx="3" fill={hue} />

      {/* Head */}
      <circle cx="0" cy="-30" r="5" fill="oklch(82% 0.04 60)" />

      {/* Headset/visor accent — hints AI without cartooning */}
      <rect
        x="-5"
        y="-31"
        width="10"
        height="1.5"
        rx="0.75"
        fill="oklch(20% 0.01 260)"
        opacity="0.6"
      />
    </svg>
  );
}
