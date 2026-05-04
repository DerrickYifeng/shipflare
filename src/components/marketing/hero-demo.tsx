'use client';

import { useState } from 'react';
import { PillCta } from '@/components/ui/pill-cta';
import { StatusDot } from '@/components/ui/status-dot';
import { Ops } from '@/components/ui/ops';
import { SignInModal } from '@/components/auth/sign-in-modal';

export interface HeroDemoProps {
  headline?: string;
  /** When authenticated, the primary CTA navigates to /briefing instead of opening sign-in. */
  isAuthenticated: boolean;
}

const DEFAULT_HEADLINE = 'The AI marketing team for solo founders.';

const AGENT_ROLES = [
  'CMO',
  'SOCIAL',
  'SEARCH',
  'PERFORMANCE',
  'CONTENT',
  'ANALYTICS',
] as const;

/**
 * Hero — static "claim" panel with a live-signal eyebrow above the headline
 * and a 6-agent role strip below the CTA. The roles tease `<HowItWorks />`
 * which sits directly below. No video here — the demo lives in `<VideoSection />`.
 */
export function HeroDemo({ headline = DEFAULT_HEADLINE, isAuthenticated }: HeroDemoProps) {
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <section
      aria-labelledby="hero-heading"
      style={{
        background: 'var(--sf-bg-dark)',
        color: 'var(--sf-fg-on-dark-1)',
        position: 'relative',
        overflow: 'hidden',
        padding: '120px 24px',
      }}
    >
      <div
        style={{
          maxWidth: 'var(--sf-max-width)',
          margin: '0 auto',
          textAlign: 'center',
        }}
      >
        {/* Eyebrow — live counter */}
        <div
          className="inline-flex items-center"
          style={{
            gap: 8,
            marginBottom: 28,
            padding: '6px 12px',
            borderRadius: 'var(--sf-radius-pill)',
            background: 'var(--sf-bg-dark-surface)',
            border: '1px solid var(--sf-border-on-dark)',
          }}
        >
          <StatusDot state="success" size={6} />
          <Ops tone="onDark" style={{ color: 'var(--sf-fg-on-dark-2)' }}>
            1,284 threads surfaced this week
          </Ops>
        </div>

        <h1
          id="hero-heading"
          className="sf-hero"
          style={{
            margin: 0,
            color: 'var(--sf-fg-on-dark-1)',
            fontSize: 'clamp(44px, 7vw, var(--sf-text-hero))',
            textWrap: 'balance',
            maxWidth: 960,
            marginInline: 'auto',
          }}
        >
          {headline}
        </h1>
        <p
          className="sf-lede"
          style={{
            marginTop: 24,
            fontSize: 'var(--sf-text-lg)',
            maxWidth: 640,
            marginInline: 'auto',
          }}
        >
          <span style={{ color: 'var(--sf-fg-on-dark-1)' }}>You ship.</span>{' '}
          <span style={{ color: 'var(--sf-link-dark)' }}>We get you seen.</span>
        </p>

        <div
          className="flex flex-wrap"
          style={{ marginTop: 40, gap: 12, justifyContent: 'center' }}
        >
          {isAuthenticated ? (
            <PillCta
              onClick={() => {
                window.location.href = '/briefing';
              }}
            >
              Open Briefing
            </PillCta>
          ) : (
            <PillCta onClick={() => setSignInOpen(true)}>
              Sign up — free while in beta
            </PillCta>
          )}
          <a
            href="#see-it"
            className="inline-flex items-center"
            style={{
              gap: 6,
              height: 48,
              padding: '0 16px',
              color: 'var(--sf-link-dark)',
              fontSize: 'var(--sf-text-base)',
              letterSpacing: 'var(--sf-track-normal)',
              textDecoration: 'none',
            }}
          >
            See it in action ↓
          </a>
        </div>

        {/* Agent roles strip — teases HowItWorks below */}
        <div
          className="flex flex-wrap items-center justify-center"
          style={{
            marginTop: 64,
            gap: 18,
            opacity: 0.85,
          }}
        >
          {AGENT_ROLES.map((role, i) => (
            <span key={role} className="inline-flex items-center" style={{ gap: 18 }}>
              <span
                style={{
                  fontFamily: 'var(--sf-font-mono)',
                  fontSize: 'var(--sf-text-xs)',
                  textTransform: 'uppercase',
                  letterSpacing: 'var(--sf-track-mono)',
                  color: 'var(--sf-fg-on-dark-3)',
                  fontWeight: 600,
                }}
              >
                {role}
              </span>
              {i < AGENT_ROLES.length - 1 ? (
                <span style={{ color: 'var(--sf-fg-on-dark-4)' }}>·</span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </section>
  );
}
