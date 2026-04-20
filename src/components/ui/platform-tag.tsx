import type { CSSProperties } from 'react';

export type PlatformTagVariant = 'reddit' | 'x' | 'hn' | string;

export interface PlatformTagProps {
  platform: PlatformTagVariant;
  size?: number;
}

/**
 * Tiny brand glyph for platform badges. 22px default, rounded for ≥18px.
 * Matches handoff pages.jsx `PlatformTag`.
 */
export function PlatformTag({ platform, size = 22 }: PlatformTagProps) {
  const bg =
    platform === 'reddit'
      ? 'oklch(58% 0.20 30)'
      : platform === 'x'
        ? 'oklch(14% 0 0)'
        : platform === 'hn'
          ? 'oklch(62% 0.19 45)'
          : 'var(--sf-paper-sunken)';

  const container: CSSProperties = {
    width: size,
    height: size,
    borderRadius: size >= 18 ? '50%' : 5,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: bg,
    flexShrink: 0,
  };

  if (platform === 'reddit') {
    const s = size * 0.62;
    return (
      <span style={container} aria-label="Reddit">
        <svg width={s} height={s} viewBox="0 0 20 20" fill="#fff" aria-hidden="true">
          <circle cx="10" cy="3" r="1.4" />
          <path d="M10 3.2 L10 7" stroke="#fff" strokeWidth="1" fill="none" strokeLinecap="round" />
          <circle cx="10" cy="11.5" r="6.2" />
          <circle cx="7.3" cy="11" r="1.15" fill={bg} />
          <circle cx="12.7" cy="11" r="1.15" fill={bg} />
          <circle cx="3.8" cy="11.5" r="1.3" />
          <circle cx="16.2" cy="11.5" r="1.3" />
          <path d="M7 13.6 Q10 15.6 13 13.6" stroke={bg} strokeWidth="0.9" fill="none" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  if (platform === 'x') {
    return (
      <span style={container} aria-label="X">
        <span style={{ fontSize: size * 0.55, fontWeight: 700, lineHeight: 1, color: '#fff' }}>
          𝕏
        </span>
      </span>
    );
  }

  if (platform === 'hn') {
    return (
      <span style={container} aria-label="Hacker News">
        <span
          style={{
            fontSize: size * 0.5,
            fontWeight: 700,
            lineHeight: 1,
            color: '#fff',
            fontFamily: 'var(--sf-font-mono)',
          }}
        >
          Y
        </span>
      </span>
    );
  }

  return (
    <span style={container}>
      <span style={{ color: 'var(--sf-fg-2)' }}>·</span>
    </span>
  );
}
