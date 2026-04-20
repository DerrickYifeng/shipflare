// TodayLandedHero — full-bleed black hero shown on /today?from=onboarding.
// Matches `design_handoff_onboarding_v2/Today Landed.html` 1:1.
//
// Collapses on:
//   - 10s timer
//   - click-through on any hero CTA
//   - scroll past threshold
// The parent owns the collapse state; this component just calls `onDismiss`.

'use client';

import { useEffect, useRef, useState } from 'react';
import { AgentPipelineCard } from './agent-pipeline-card';
import { OnbMono } from '@/components/onboarding/_shared/onb-mono';
import { ArrowRight } from '@/components/onboarding/icons';

interface TodayLandedHeroProps {
  /** Collapses the hero back into the normal /today layout. */
  onDismiss: () => void;
  /** ms until the auto-collapse fires. Default 10_000. */
  autoDismissMs?: number;
  /** Where "Revisit plan →" navigates. Defaults to /settings (no plan page yet). */
  revisitPlanHref?: string;
  /** Optional override for the dismissed state URL on "Explore sample draft". */
  sampleDraftHref?: string;
}

const AUTO_DISMISS_DEFAULT_MS = 10_000;
const SCROLL_DISMISS_THRESHOLD_PX = 60;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function TodayLandedHero({
  onDismiss,
  autoDismissMs = AUTO_DISMISS_DEFAULT_MS,
  revisitPlanHref = '/settings',
  sampleDraftHref = '/today?dismiss=1',
}: TodayLandedHeroProps) {
  const [elapsed, setElapsed] = useState(0);
  const dismissedRef = useRef(false);

  const dismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    onDismiss();
  };

  // Uptime counter + auto-dismiss timer share the same interval.
  useEffect(() => {
    const i = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (autoDismissMs <= 0) return;
    const t = setTimeout(dismiss, autoDismissMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDismissMs]);

  // Scroll-past-threshold dismiss.
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > SCROLL_DISMISS_THRESHOLD_PX) dismiss();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const entranceAnimation = prefersReducedMotion()
    ? 'none'
    : 'sf-slide-up 400ms cubic-bezier(0.16,1,0.3,1) both';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--sf-bg-dark)',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 40,
        overflow: 'auto',
      }}
    >
      <header
        style={{
          padding: '16px 40px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'var(--sf-accent)',
          }}
        />
        <span
          style={{
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: '-0.374px',
            color: 'var(--sf-fg-on-dark-1)',
          }}
        >
          ShipFlare
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 10px',
            borderRadius: 980,
            background: 'rgba(52,199,89,0.14)',
            border: '1px solid rgba(52,199,89,0.24)',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--sf-success)',
              animation: prefersReducedMotion()
                ? 'none'
                : 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
            }}
          />
          <OnbMono color="var(--sf-success)" style={{ fontSize: 10 }}>
            Pipeline live · {String(mins).padStart(2, '0')}:
            {String(secs).padStart(2, '0')}
          </OnbMono>
        </span>
      </header>

      <main
        style={{
          flex: 1,
          padding: '56px clamp(20px, 5vw, 40px) 80px',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 980,
            animation: entranceAnimation,
          }}
        >
          <OnbMono color="var(--sf-fg-on-dark-4)">Setup · complete</OnbMono>
          <h1
            style={{
              margin: '14px 0 0',
              fontSize: 'clamp(36px, 6vw, 56px)',
              fontWeight: 600,
              lineHeight: 1.07,
              letterSpacing: '-0.28px',
              color: 'var(--sf-fg-on-dark-1)',
            }}
          >
            You&apos;re set.
            <br />
            <span style={{ color: 'var(--sf-fg-on-dark-3)' }}>
              Scout is already working.
            </span>
          </h1>
          <p
            style={{
              margin: '18px 0 0',
              maxWidth: 560,
              fontSize: 17,
              lineHeight: 1.47,
              letterSpacing: '-0.224px',
              color: 'var(--sf-fg-on-dark-2)',
            }}
          >
            First drafts land here in about an hour. Nothing posts until you
            approve.
          </p>

          <div
            style={{
              marginTop: 40,
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
              gap: 16,
            }}
            className="today-landed-grid"
          >
            <AgentPipelineCard />
            <section
              style={{
                background: 'var(--sf-bg-dark-surface)',
                borderRadius: 12,
                padding: '18px 20px',
              }}
            >
              <OnbMono color="var(--sf-fg-on-dark-4)">
                What happens next
              </OnbMono>
              <div
                style={{
                  marginTop: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 18,
                }}
              >
                {NEXT_STEPS.map((x) => (
                  <div key={x.n}>
                    <OnbMono color="var(--sf-fg-on-dark-4)">{x.n}</OnbMono>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 14,
                        fontWeight: 500,
                        letterSpacing: '-0.16px',
                        color: 'var(--sf-fg-on-dark-1)',
                      }}
                    >
                      {x.label}
                    </div>
                    <div
                      style={{
                        marginTop: 2,
                        fontSize: 12,
                        letterSpacing: '-0.12px',
                        color: 'var(--sf-fg-on-dark-3)',
                      }}
                    >
                      {x.detail}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div
            style={{
              marginTop: 40,
              padding: '20px 24px',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              border: '1px dashed rgba(255,255,255,0.14)',
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ flex: 1, minWidth: 240 }}>
              <OnbMono color="var(--sf-fg-on-dark-4)">
                Your queue · empty
              </OnbMono>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 17,
                  fontWeight: 500,
                  letterSpacing: '-0.224px',
                  color: 'var(--sf-fg-on-dark-1)',
                }}
              >
                Nothing to approve yet.
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  lineHeight: 1.47,
                  letterSpacing: '-0.16px',
                  color: 'var(--sf-fg-on-dark-3)',
                  maxWidth: 520,
                }}
              >
                First drafts arrive after Scout finds high-signal threads and
                Content composes replies in your voice. You can relax; we&apos;ll
                ping you.
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                flexShrink: 0,
              }}
            >
              <a
                href={revisitPlanHref}
                onClick={dismiss}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 40,
                  padding: '0 18px',
                  borderRadius: 980,
                  background: 'var(--sf-accent)',
                  color: '#fff',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  letterSpacing: '-0.224px',
                  textDecoration: 'none',
                  transition: 'background 200ms cubic-bezier(0.16,1,0.3,1)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--sf-accent-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--sf-accent)';
                }}
              >
                Revisit plan <ArrowRight size={14} />
              </a>
              <a
                href={sampleDraftHref}
                onClick={(e) => {
                  e.preventDefault();
                  dismiss();
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  height: 40,
                  padding: '0 18px',
                  borderRadius: 980,
                  background: 'transparent',
                  color: 'var(--sf-fg-on-dark-2)',
                  border: '1px solid rgba(255,255,255,0.16)',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  letterSpacing: '-0.224px',
                  cursor: 'pointer',
                  textDecoration: 'none',
                }}
              >
                Explore sample draft
              </a>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        @media (max-width: 720px) {
          .today-landed-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

const NEXT_STEPS = [
  { n: '01', label: 'First drafts',    detail: '~1 hour · email when ready' },
  { n: '02', label: 'Approve & send',  detail: '/today · expect ~8 replies/day' },
  { n: '03', label: 'Tune your voice', detail: 'refine anytime · /voice' },
] as const;
