'use client';

/**
 * Theme toggle — sun ↔ moon @ 15px. 32×32 square, --sf-radius-md.
 * No border by default; on hover bg `--sf-bg-tertiary`, icon color fg-1.
 * Matches INTERACTIONS.md §2 and §8.
 */

import { useState } from 'react';
import { useTheme } from './theme-provider';

export function ThemeToggleButton() {
  const { theme, toggle, hydrated } = useTheme();
  const isDark = theme === 'dark';
  const [hover, setHover] = useState(false);

  // Until the provider has read the real theme on the client, render a
  // stable, icon-less button so the SSR'd HTML and the first client paint
  // match. Both server and first client render produce the same markup;
  // the icon and label appear after hydration.
  const label = hydrated
    ? isDark
      ? 'Switch to light theme'
      : 'Switch to dark theme'
    : 'Toggle theme';

  return (
    <button
      type="button"
      onClick={toggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      aria-label={label}
      suppressHydrationWarning
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: 'var(--sf-radius-md)',
        border: '1px solid var(--sf-border-subtle)',
        background: hover ? 'var(--sf-bg-tertiary)' : 'transparent',
        color: hover ? 'var(--sf-fg-1)' : 'var(--sf-fg-2)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      {!hydrated ? (
        // Placeholder reserves the 15×15 icon slot so layout doesn't shift
        // when the real icon mounts.
        <span aria-hidden="true" style={{ width: 15, height: 15 }} />
      ) : isDark ? (
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
