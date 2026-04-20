/**
 * Small 22×26 SVG "ticket" glyph carried above a walking character
 * during handoffs. Color is driven by the handoff kind.
 */

import type { CSSProperties } from 'react';

export type TicketKind = 'draft' | 'review' | 'post' | 'done';

export interface TicketGlyphProps {
  kind?: TicketKind;
  size?: number;
}

const KIND_COLOR: Record<TicketKind, string> = {
  draft: 'var(--sf-signal)',
  review: 'var(--sf-flare)',
  post: 'var(--sf-success)',
  done: 'oklch(60% 0.01 260)',
};

const WRAPPER_STYLE: CSSProperties = {
  display: 'block',
  filter: 'drop-shadow(0 2px 3px oklch(20% 0 0 / 0.25))',
};

export function TicketGlyph({ kind = 'draft', size = 22 }: TicketGlyphProps) {
  const color = KIND_COLOR[kind];
  return (
    <svg
      width={size}
      height={size * 1.2}
      viewBox="0 0 22 26"
      aria-hidden="true"
      style={WRAPPER_STYLE}
    >
      <rect
        x="1"
        y="1"
        width="20"
        height="22"
        rx="2.5"
        fill="oklch(98% 0.005 60)"
        stroke={color}
        strokeWidth="1.5"
      />
      <rect x="4" y="5" width="14" height="1.5" fill={color} opacity="0.6" />
      <rect x="4" y="8" width="10" height="1.5" fill={color} opacity="0.4" />
      <rect x="4" y="11" width="12" height="1.5" fill={color} opacity="0.4" />
      <rect x="4" y="17" width="6" height="3" rx="1" fill={color} />
    </svg>
  );
}
