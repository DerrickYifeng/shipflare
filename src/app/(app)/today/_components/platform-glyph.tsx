/**
 * ShipFlare v2 — PlatformGlyph
 *
 * Round circular platform mark. Reddit uses a simplified Snoo; X uses its
 * bold 𝕏 glyph; HN falls back to a mono Y. Ported from the design handoff
 * `source/app/today.jsx`.
 */

import type { CSSProperties } from 'react';

interface PlatformGlyphProps {
  platform: string;
  size?: number;
}

function platformBackground(platform: string): string {
  if (platform === 'x') return 'oklch(14% 0 0)';
  if (platform === 'reddit') return 'oklch(58% 0.20 30)';
  if (platform === 'hn') return 'oklch(62% 0.19 45)';
  return 'var(--sf-signal)';
}

export function PlatformGlyph({ platform, size = 22 }: PlatformGlyphProps) {
  const bg = platformBackground(platform);

  const wrapperStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    borderRadius: '50%',
    background: bg,
    color: '#fff',
    flexShrink: 0,
  };

  if (platform === 'reddit') {
    const s = size * 0.62;
    return (
      <span style={wrapperStyle} aria-hidden="true">
        <svg width={s} height={s} viewBox="0 0 20 20" fill="#fff">
          <circle cx="10" cy="3" r="1.4" />
          <path
            d="M10 3.2 L10 7"
            stroke="#fff"
            strokeWidth="1"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="10" cy="11.5" r="6.2" />
          <circle cx="7.3" cy="11" r="1.15" fill={bg} />
          <circle cx="12.7" cy="11" r="1.15" fill={bg} />
          <circle cx="3.8" cy="11.5" r="1.3" />
          <circle cx="16.2" cy="11.5" r="1.3" />
          <path
            d="M7 13.6 Q10 15.6 13 13.6"
            stroke={bg}
            strokeWidth="0.9"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  if (platform === 'x') {
    return (
      <span style={wrapperStyle} aria-hidden="true">
        <span style={{ fontSize: size * 0.6, fontWeight: 700, lineHeight: 1 }}>
          𝕏
        </span>
      </span>
    );
  }

  if (platform === 'hn') {
    return (
      <span style={wrapperStyle} aria-hidden="true">
        <span
          style={{
            fontSize: size * 0.55,
            fontWeight: 700,
            lineHeight: 1,
            fontFamily: 'var(--sf-font-mono)',
          }}
        >
          Y
        </span>
      </span>
    );
  }

  return (
    <span style={wrapperStyle} aria-hidden="true">
      ?
    </span>
  );
}
