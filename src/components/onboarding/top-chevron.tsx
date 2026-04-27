// TopChevron — absolute top-left ghost button for Back/Cancel.
// Rendered on every stage except source (stage 1).

'use client';

import { useState } from 'react';
import { ArrowLeft } from './icons';

interface TopChevronProps {
  onClick: () => void;
  label?: string;
}

export function TopChevron({ onClick, label = 'Back' }: TopChevronProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        top: 28,
        left: 40,
        zIndex: 5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: hover ? 'rgba(0,0,0,0.04)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        letterSpacing: '-0.16px',
        color: hover ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
        padding: '6px 10px 6px 6px',
        borderRadius: 8,
        transition: 'background 150ms, color 150ms',
      }}
    >
      <ArrowLeft size={14} /> {label}
    </button>
  );
}
