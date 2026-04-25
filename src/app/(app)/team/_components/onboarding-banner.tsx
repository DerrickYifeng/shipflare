'use client';

import { useEffect, useState, type CSSProperties } from 'react';

const STORAGE_KEY = 'sf:team-onboarding-banner-dismissed:v1';

export function OnboardingBanner(): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      const flag = window.localStorage.getItem(STORAGE_KEY);
      if (flag !== '1') setDismissed(false);
    } catch {
      // localStorage may be blocked — show once anyway, harmless.
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  const wrap: CSSProperties = {
    background: 'var(--sf-accent-soft, oklch(95% 0.04 250))',
    border: '1px solid var(--sf-border-subtle)',
    borderRadius: 'var(--sf-radius-md)',
    padding: '12px 16px',
    margin: '0 0 16px',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  };
  const text: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-1)',
    lineHeight: 1.5,
    margin: 0,
  };
  const btn: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--sf-fg-3)',
    cursor: 'pointer',
    fontSize: 'var(--sf-text-sm)',
    padding: '4px 8px',
  };

  return (
    <div style={wrap} role="status" aria-live="polite">
      <p style={text}>
        <strong>Your team just got the brief.</strong>
        {' '}Watch them plan your first week, scan X for live conversations,
        and draft replies — drafts land in <a href="/today">/today</a> for your approval.
      </p>
      <button
        type="button"
        style={btn}
        onClick={() => {
          try {
            window.localStorage.setItem(STORAGE_KEY, '1');
          } catch {
            /* ignore */
          }
          setDismissed(true);
        }}
        aria-label="Dismiss onboarding banner"
      >
        Dismiss
      </button>
    </div>
  );
}
