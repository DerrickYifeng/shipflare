'use client';

/**
 * Theme toggle — sun ↔ moon @ 15px. 32×32 square, --sf-radius-md.
 * No border by default; on hover bg `--sf-paper-sunken`, icon color fg-1.
 * Matches INTERACTIONS.md §2 and §8.
 */

import { useState } from 'react';
import { useTheme } from './theme-provider';

export function ThemeToggleButton() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  const [hover, setHover] = useState(false);

  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      onClick={toggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 'var(--sf-radius-md)',
        border: '1px solid var(--sf-border-subtle)',
        background: hover ? 'var(--sf-paper-sunken)' : 'transparent',
        color: hover ? 'var(--sf-fg-1)' : 'var(--sf-fg-2)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      {isDark ? (
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.3 3.3l1 1M11.7 11.7l1 1M3.3 12.7l1-1M11.7 4.3l1-1" />
        </svg>
      ) : (
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M13.5 10.2a5.5 5.5 0 0 1-7.7-7.7 6 6 0 1 0 7.7 7.7z" />
        </svg>
      )}
    </button>
  );
}
