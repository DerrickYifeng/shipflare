'use client';

import Link from 'next/link';
import { useState } from 'react';

/**
 * Primary pill CTA that links to /waitlist.
 * Mirrors PillCta's hover-state pattern: swaps --sf-accent → --sf-accent-hover
 * on pointer-over so the colour transition is interactive, not static.
 */
export function WaitlistPillLink() {
  const [hover, setHover] = useState(false);
  return (
    <Link
      href="/waitlist"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 48,
        padding: '0 24px',
        background: hover ? 'var(--sf-accent-hover)' : 'var(--sf-accent)',
        color: 'var(--sf-fg-on-dark-1)',
        borderRadius: 'var(--sf-radius-pill)',
        fontSize: '17px',
        fontWeight: 500,
        letterSpacing: '-0.224px',
        textDecoration: 'none',
        transition: 'background var(--sf-dur-base) var(--sf-ease)',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      Request alpha access
      <span style={{ fontSize: 16 }} aria-hidden="true">→</span>
    </Link>
  );
}

export interface AlreadyInvitedButtonProps {
  onClick: () => void;
}

/** Ghost button that opens the sign-in modal for already-invited users. */
export function AlreadyInvitedButton({ onClick }: AlreadyInvitedButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        marginTop: 12,
        background: 'transparent',
        border: 'none',
        color: 'var(--sf-fg-on-dark-3)',
        fontSize: 14,
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
      }}
    >
      Already invited? Sign in with GitHub
    </button>
  );
}
