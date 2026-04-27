// TodayWelcomeRibbon — persistent dismissible banner pinned above the
// Today feed after the landed hero collapses. Persists via localStorage
// for 24h or until the user hits `×`.

'use client';

import { useEffect, useState } from 'react';

const DISMISSED_KEY = 'sf:onboarded-ribbon-dismissed';
const HERO_SEEN_KEY = 'sf:onboarded-hero-seen';
const RIBBON_TTL_MS = 24 * 60 * 60 * 1000;

interface TodayWelcomeRibbonProps {
  /** onboardingCompletedAt from the server, or null if unknown. */
  onboardingCompletedAt: Date | null;
}

/**
 * Returns whether the ribbon should currently render.
 *
 * Client-only decision — the server cannot read localStorage. We render
 * an empty placeholder until `mounted` to avoid hydration mismatch.
 */
function shouldShowRibbon(onboardingCompletedAt: Date | null): boolean {
  if (!onboardingCompletedAt) return false;
  const ageMs = Date.now() - onboardingCompletedAt.getTime();
  if (ageMs > RIBBON_TTL_MS) return false;
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(DISMISSED_KEY) !== '1';
}

function formatMinutesAgo(d: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function TodayWelcomeRibbon({
  onboardingCompletedAt,
}: TodayWelcomeRibbonProps) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const visible = shouldShowRibbon(onboardingCompletedAt);
    queueMicrotask(() => {
      setMounted(true);
      setVisible(visible);
    });
  }, [onboardingCompletedAt]);

  if (!mounted || !visible || !onboardingCompletedAt) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* private mode / quota — accept ephemeral dismissal */
    }
    setVisible(false);
  };

  return (
    <div
      role="status"
      style={{
        margin: '0 clamp(16px, 3vw, 32px) 16px',
        padding: '12px 14px',
        background: 'rgba(0,113,227,0.06)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        border: '1px solid rgba(0,113,227,0.10)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--sf-accent)',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--sf-link)',
          letterSpacing: '-0.16px',
        }}
      >
        Setup complete. Your AI team is live.
      </div>
      <span
        style={{
          fontFamily: 'var(--sf-font-mono)',
          fontSize: 11,
          letterSpacing: '-0.08px',
          color: 'rgba(0,102,204,0.72)',
          fontVariantNumeric: 'tabular-nums',
          textTransform: 'uppercase',
        }}
      >
        Scout started {formatMinutesAgo(onboardingCompletedAt)} · first results
        in ~1h
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss welcome banner"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 4,
          margin: -4,
          color: 'rgba(0,102,204,0.64)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'inherit',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  );
}

/** Exported so other surfaces (e.g. a future inbox) can clear these too. */
export const WELCOME_RIBBON_DISMISSED_KEY = DISMISSED_KEY;
export const WELCOME_HERO_SEEN_KEY = HERO_SEEN_KEY;
