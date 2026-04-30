'use client';

import { useState } from 'react';
import { PillCta } from '@/components/ui/pill-cta';
import { Ops } from '@/components/ui/ops';
import { SignInModal } from '@/components/auth/sign-in-modal';

export interface CTASectionProps {
  isAuthenticated: boolean;
}

/**
 * Final CTA — dark section with radial signal-gradient wash.
 *
 * Auth is GitHub-only during beta (no email/password, no Google, no X).
 * Unauthenticated: primary pill triggers SignInModal → GitHub OAuth.
 * Authenticated: pill links to /today.
 * Google / X are shown as "coming soon" affordances so visitors know
 * they're planned, but the only working path is GitHub.
 */
export function CTASection({ isAuthenticated }: CTASectionProps) {
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <section
      id="signup"
      aria-labelledby="cta-heading"
      style={{
        // Prototype source/landing/cta_footer.jsx:5 — dark ink base with a
        // soft signal-coloured radial glow centred above the headline. The
        // README's "signal gradient" label refers to this halo, not a full
        // linear slab. Keeps the alternating rhythm's final dark beat
        // (ink → paper → ink → paper → ink+glow → ink) while marking the
        // CTA as the signature moment.
        background: 'var(--sf-bg-primary)',
        color: 'var(--sf-fg-1)',
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
            'radial-gradient(ellipse 60% 50% at 50% 40%, oklch(62% 0.19 255 / 0.14), transparent 65%)',
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
            color: 'var(--sf-fg-1)',
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
          }}
        >
          Free while in beta. Set up in under a minute. No credit card.
        </p>

        <div
          style={{ marginTop: 40, display: 'flex', justifyContent: 'center' }}
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
              <GithubMark />
              Continue with GitHub
            </PillCta>
          )}
        </div>

        {!isAuthenticated && (
          <div
            className="flex flex-wrap items-center justify-center"
            style={{ marginTop: 24, gap: 20 }}
          >
            <Ops>coming soon</Ops>
            <span
              style={{
                color: 'var(--sf-fg-4)',
                fontSize: 'var(--sf-text-xs)',
                fontFamily: 'var(--sf-font-mono)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--sf-track-mono)',
                opacity: 0.7,
              }}
            >
              Google
            </span>
            <span
              style={{
                color: 'var(--sf-fg-4)',
                fontSize: 'var(--sf-text-xs)',
                fontFamily: 'var(--sf-font-mono)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--sf-track-mono)',
                opacity: 0.7,
              }}
            >
              𝕏
            </span>
            <span
              style={{
                color: 'var(--sf-fg-4)',
                fontSize: 'var(--sf-text-xs)',
                fontFamily: 'var(--sf-font-mono)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--sf-track-mono)',
                opacity: 0.7,
              }}
            >
              Email
            </span>
          </div>
        )}
      </div>
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
    </section>
  );
}

function GithubMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      style={{ flexShrink: 0 }}
    >
      <path d="M12 .5C5.73.5.67 5.56.67 11.83c0 4.97 3.23 9.19 7.7 10.68.56.1.77-.24.77-.55v-1.93c-3.14.68-3.8-1.51-3.8-1.51-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.64 1.22 3.29.94.1-.72.39-1.22.71-1.5-2.51-.29-5.15-1.25-5.15-5.58 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.97 0 0 .94-.3 3.08 1.16.9-.25 1.86-.37 2.82-.38.96.01 1.92.13 2.82.38 2.14-1.46 3.08-1.16 3.08-1.16.61 1.54.23 2.69.11 2.97.72.79 1.16 1.80 1.16 3.03 0 4.34-2.64 5.29-5.16 5.57.4.35.76 1.04.76 2.09v3.1c0 .31.2.66.78.55C20.11 21.01 23.33 16.8 23.33 11.83 23.33 5.56 18.27.5 12 .5Z" />
    </svg>
  );
}
