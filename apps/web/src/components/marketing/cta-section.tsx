'use client';

import { useState } from 'react';
import { PillCta } from '@/components/ui/pill-cta';
import { SignInModal } from '@/components/auth/sign-in-modal';
import { WaitlistPillLink, AlreadyInvitedButton } from './waitlist-cta';

export interface CTASectionProps {
  isAuthenticated: boolean;
}

/**
 * Final CTA — dark section with radial signal-gradient wash.
 *
 * Auth is GitHub-only during beta (no email/password, no Google, no X).
 * Unauthenticated: primary pill triggers SignInModal → GitHub OAuth.
 * Authenticated: pill links to /briefing.
 */
export function CTASection({ isAuthenticated }: CTASectionProps) {
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <section
      id="signup"
      aria-labelledby="cta-heading"
      style={{
        background: 'var(--sf-bg-dark)',
        color: 'var(--sf-fg-on-dark-1)',
        padding: '120px 24px',
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
            'radial-gradient(ellipse 60% 50% at 50% 40%, oklch(62% 0.19 255 / 0.22), transparent 65%)',
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
          Hire your
          <br />
          marketing team.
        </h2>
        <p
          className="sf-lede"
          style={{
            marginTop: 20,
            fontSize: 'var(--sf-text-lg)',
            color: 'var(--sf-fg-on-dark-2)',
          }}
        >
          Free while in beta. Set up in under a minute. No credit card.
        </p>

        <div
          style={{ marginTop: 40, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
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
            <>
              <WaitlistPillLink />
              <AlreadyInvitedButton onClick={() => setSignInOpen(true)} />
            </>
          )}
        </div>
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </section>
  );
}
