/**
 * Isometric 2.5D desk, 96×72 SVG centered on (0,0).
 * Mirrors the prototype `IsoDesk` exactly — see PIXEL_ART.md for geometry.
 * Each desk takes a `hue` that drives the screen glow while `active`.
 */

import { useId, type CSSProperties } from 'react';

export interface IsoDeskProps {
  /** Agent hue — painted on the monitor's inner rect when active. */
  hue?: string;
  /** Dims/brightens the monitor glow; true when the agent is processing. */
  active?: boolean;
}

const WRAPPER_STYLE: CSSProperties = {
  display: 'block',
  overflow: 'visible',
};

export function IsoDesk({ hue = 'oklch(70% 0.02 260)', active = false }: IsoDeskProps) {
  // useId guarantees unique gradient ids when multiple desks render in the DOM.
  const gradId = useId();
  return (
    <svg width="96" height="72" viewBox="-48 -56 96 72" aria-hidden="true" style={WRAPPER_STYLE}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(92% 0.005 60)" />
          <stop offset="1" stopColor="oklch(86% 0.008 60)" />
        </linearGradient>
      </defs>

      {/* Front-left slab (darker = sun from right) */}
      <polygon points="-40,-4 0,16 0,24 -40,4" fill="oklch(76% 0.01 60)" />

      {/* Front-right slab */}
      <polygon points="40,-4 0,16 0,24 40,4" fill="oklch(82% 0.008 60)" />

      {/* Top diamond */}
      <polygon
        points="-40,-4 0,-24 40,-4 0,16"
        fill={`url(#${gradId})`}
        stroke="oklch(72% 0.01 60)"
        strokeWidth="0.5"
      />

      {/* Monitor base (back half) */}
      <polygon
        points="-16,-18 0,-26 16,-18 0,-10"
        fill="oklch(30% 0.01 260)"
        opacity="0.35"
      />

      {/* Monitor screen */}
      <g transform="translate(0 -24)">
        <rect x="-14" y="-20" width="28" height="18" rx="1.5" fill="oklch(16% 0.012 260)" />
        <rect
          x="-12"
          y="-18"
          width="24"
          height="14"
          rx="0.5"
          fill={active ? hue : 'oklch(28% 0.02 250)'}
          opacity={active ? 0.85 : 0.6}
        />

        {/* Fake UI lines on the monitor */}
        <rect x="-10" y="-16" width="12" height="1.2" fill="oklch(96% 0.005 60)" opacity="0.7" />
        <rect x="-10" y="-13.5" width="18" height="1.2" fill="oklch(96% 0.005 60)" opacity="0.5" />
        <rect x="-10" y="-11" width="8" height="1.2" fill="oklch(96% 0.005 60)" opacity="0.5" />

        {/* Stand */}
        <rect x="-2" y="-2" width="4" height="3" fill="oklch(30% 0.01 260)" />
        <polygon points="-6,1 6,1 5,2.5 -5,2.5" fill="oklch(30% 0.01 260)" />
      </g>
    </svg>
  );
}
