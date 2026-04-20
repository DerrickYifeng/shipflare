'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { SignInModal } from '@/components/auth/sign-in-modal';
import { ShipFlareLogo } from '@/components/ui/shipflare-logo';

export interface GlassNavProps {
  isAuthenticated: boolean;
}

const LINK_STYLE: CSSProperties = {
  fontSize: 'var(--sf-text-sm)',
  color: 'var(--sf-fg-on-dark-2)',
  letterSpacing: 'var(--sf-track-normal)',
  textDecoration: 'none',
  cursor: 'pointer',
};

/**
 * Dark glass sticky nav — v2 marketing site.
 * Logo mark (diamond-in-square), section anchors, auth CTA.
 * Matches source/landing/nav.jsx with real auth wiring.
 */
export function GlassNav({ isAuthenticated }: GlassNavProps) {
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <header
      className="sticky top-0 backdrop-blur"
      style={{
        zIndex: 'var(--sf-z-sticky)' as unknown as number,
        background: 'var(--sf-glass-dark)',
        backdropFilter: 'var(--sf-glass-blur)',
        WebkitBackdropFilter: 'var(--sf-glass-blur)',
        borderBottom: '1px solid var(--sf-border-on-dark)',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{
          maxWidth: 'var(--sf-max-width)',
          margin: '0 auto',
          padding: '14px 24px',
        }}
      >
        <Link
          href="/"
          className="flex items-center gap-[10px]"
          style={{ textDecoration: 'none' }}
          aria-label="ShipFlare home"
        >
          <ShipFlareLogo size={22} />
          <span
            style={{
              fontSize: 'var(--sf-text-sm)',
              fontWeight: 500,
              color: 'var(--sf-fg-on-dark-1)',
              letterSpacing: 'var(--sf-track-tight)',
            }}
          >
            ShipFlare
          </span>
        </Link>

        <nav className="flex items-center" style={{ gap: 28 }} aria-label="Main navigation">
          <a href="#how" style={LINK_STYLE} className="hidden sm:inline">
            How it works
          </a>
          <a href="#threads" style={LINK_STYLE} className="hidden sm:inline">
            Discovered
          </a>
          <a href="#safety" style={LINK_STYLE} className="hidden sm:inline">
            Safety
          </a>
          {isAuthenticated ? (
            <Link
              href="/today"
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-on-dark-1)',
                letterSpacing: 'var(--sf-track-normal)',
                padding: '8px 16px',
                borderRadius: 'var(--sf-radius-pill)',
                background: 'var(--sf-signal)',
                textDecoration: 'none',
                fontWeight: 500,
              }}
              className="inline-flex items-center"
            >
              Today
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setSignInOpen(true)}
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-on-dark-1)',
                letterSpacing: 'var(--sf-track-normal)',
                padding: '8px 16px',
                borderRadius: 'var(--sf-radius-pill)',
                background: 'var(--sf-signal)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 500,
                fontFamily: 'inherit',
              }}
              className="inline-flex items-center"
            >
              Sign up
            </button>
          )}
        </nav>
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </header>
  );
}
