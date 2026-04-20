'use client';

import { useState, type FormEvent } from 'react';
import { PillCta } from '@/components/ui/pill-cta';
import { Ops } from '@/components/ui/ops';
import { SignInModal } from '@/components/auth/sign-in-modal';

export interface CTASectionProps {
  isAuthenticated: boolean;
}

/**
 * Final CTA — dark section with radial signal-gradient wash + sign-up form.
 * Unauthenticated: surfaces the SignInModal. Authenticated: links to /today.
 */
export function CTASection({ isAuthenticated }: CTASectionProps) {
  const [signInOpen, setSignInOpen] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isAuthenticated) {
      window.location.href = '/today';
      return;
    }
    setSignInOpen(true);
  }

  return (
    <section
      id="signup"
      aria-labelledby="cta-heading"
      style={{
        background: 'var(--sf-ink)',
        color: 'var(--sf-fg-on-dark-1)',
        padding: '140px 24px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(ellipse 60% 50% at 50% 40%, oklch(62% 0.19 255 / 0.20), transparent 60%)',
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          textAlign: 'center',
          position: 'relative',
        }}
      >
        <h2
          id="cta-heading"
          className="sf-hero"
          style={{
            margin: 0,
            color: 'var(--sf-fg-on-dark-1)',
            fontSize: 'clamp(40px, 5.5vw, var(--sf-text-hero))',
            textWrap: 'balance',
          }}
        >
          Start shipping where
          <br />
          your users already are.
        </h2>
        <p
          className="sf-lede"
          style={{
            marginTop: 20,
            color: 'var(--sf-fg-on-dark-2)',
            fontSize: 'var(--sf-text-lg)',
          }}
        >
          Free while in beta. Set up in under a minute. No credit card.
        </p>

        {isAuthenticated ? (
          <div style={{ marginTop: 40, display: 'flex', justifyContent: 'center' }}>
            <PillCta
              onClick={() => {
                window.location.href = '/today';
              }}
            >
              Open Today
            </PillCta>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            style={{
              marginTop: 40,
              display: 'flex',
              gap: 10,
              maxWidth: 480,
              marginInline: 'auto',
              background: 'var(--sf-ink-raised)',
              border: '1px solid var(--sf-border-on-dark)',
              borderRadius: 'var(--sf-radius-lg)',
              padding: 6,
            }}
          >
            <input
              type="email"
              name="email"
              placeholder="you@yourproduct.com"
              aria-label="Email address"
              autoComplete="email"
              style={{
                flex: 1,
                minHeight: 48,
                padding: '0 16px',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--sf-fg-on-dark-1)',
                fontSize: 'var(--sf-text-base)',
                letterSpacing: 'var(--sf-track-normal)',
                fontFamily: 'inherit',
              }}
            />
            <button
              type="submit"
              style={{
                minHeight: 48,
                padding: '0 22px',
                borderRadius: 'var(--sf-radius-md)',
                background: 'var(--sf-signal)',
                color: 'var(--sf-fg-on-dark-1)',
                border: 'none',
                cursor: 'pointer',
                fontSize: 'var(--sf-text-sm)',
                fontWeight: 500,
                fontFamily: 'inherit',
              }}
            >
              Sign up
            </button>
          </form>
        )}

        {!isAuthenticated && (
          <div
            className="flex flex-wrap items-center justify-center"
            style={{ marginTop: 24, gap: 20 }}
          >
            <Ops tone="onDark">or continue with</Ops>
            <button
              type="button"
              onClick={() => setSignInOpen(true)}
              style={{
                color: 'var(--sf-fg-on-dark-2)',
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: 'var(--sf-text-xs)',
                fontFamily: 'var(--sf-font-mono)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--sf-track-mono)',
              }}
            >
              GitHub ↗
            </button>
          </div>
        )}
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </section>
  );
}
