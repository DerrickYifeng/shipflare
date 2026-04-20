'use client';

import { useState } from 'react';
import { PillCta } from '@/components/ui/pill-cta';
import { StatusDot } from '@/components/ui/status-dot';
import { Ops } from '@/components/ui/ops';
import { SignInModal } from '@/components/auth/sign-in-modal';
import { DemoWindow } from './demo-window';

export interface HeroDemoProps {
  headline?: string;
  /** When authenticated, the primary CTA navigates to /today instead of opening sign-in. */
  isAuthenticated: boolean;
}

const DEFAULT_HEADLINE = 'Marketing autopilot for indie developers.';

/**
 * Hero section — dark `--sf-ink` bg, centered eyebrow badge, hero headline,
 * lede, CTA pair, and the auto-playing DemoWindow.
 */
export function HeroDemo({ headline = DEFAULT_HEADLINE, isAuthenticated }: HeroDemoProps) {
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <section
      aria-labelledby="hero-heading"
      style={{
        background: 'var(--sf-ink)',
        color: 'var(--sf-fg-on-dark-1)',
        position: 'relative',
        overflow: 'hidden',
        padding: '72px 24px 96px',
      }}
    >
      <div
        style={{
          maxWidth: 'var(--sf-max-width)',
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: 64,
          alignItems: 'center',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 760, margin: '0 auto' }}>
          <div
            className="inline-flex items-center"
            style={{
              gap: 8,
              marginBottom: 24,
              padding: '6px 12px',
              borderRadius: 'var(--sf-radius-pill)',
              background: 'var(--sf-ink-raised)',
              border: '1px solid var(--sf-border-on-dark)',
            }}
          >
            <StatusDot state="success" size={6} />
            <Ops tone="onDark" style={{ color: 'var(--sf-fg-on-dark-2)' }}>
              Live — 1,284 threads surfaced this week
            </Ops>
          </div>
          <h1
            id="hero-heading"
            className="sf-hero"
            style={{
              margin: 0,
              color: 'var(--sf-fg-on-dark-1)',
              fontSize: 'clamp(40px, 6vw, var(--sf-text-hero))',
              textWrap: 'balance',
            }}
          >
            {headline}
          </h1>
          <p
            className="sf-lede"
            style={{
              marginTop: 20,
              color: 'var(--sf-fg-on-dark-2)',
              fontSize: 'var(--sf-text-lg)',
              maxWidth: 560,
              marginInline: 'auto',
            }}
          >
            A pipeline of agents finds where your users actually hang out, drafts replies in your voice, and passes each one through an adversarial review before you approve.
          </p>
          <div
            className="flex flex-wrap"
            style={{ marginTop: 36, gap: 12, justifyContent: 'center' }}
          >
            {isAuthenticated ? (
              <PillCta
                onClick={() => {
                  window.location.href = '/today';
                }}
              >
                Open Today
              </PillCta>
            ) : (
              <PillCta onClick={() => setSignInOpen(true)}>
                Sign up — free while in beta
              </PillCta>
            )}
            <a
              href="#how"
              className="inline-flex items-center"
              style={{
                gap: 6,
                height: 48,
                padding: '0 16px',
                color: 'var(--sf-signal-bright)',
                fontSize: 'var(--sf-text-base)',
                letterSpacing: 'var(--sf-track-normal)',
                textDecoration: 'none',
              }}
            >
              See how it works ›
            </a>
          </div>
        </div>

        <div style={{ marginTop: 24 }}>
          <DemoWindow />
        </div>
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </section>
  );
}
