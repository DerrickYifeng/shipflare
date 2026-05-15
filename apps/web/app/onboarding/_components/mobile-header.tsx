// MobileHeader — 48px white header used on <880px.
// Back arrow (or logo on stage 1) + 4-segment progress bar + "N/4" counter.

import Image from 'next/image';
import { ArrowLeft } from './icons';
import { OnbMono } from './_shared/onb-mono';

interface MobileHeaderProps {
  step: 0 | 1 | 2 | 3;
  onBack?: (() => void) | null;
}

export function MobileHeader({ step, onBack }: MobileHeaderProps) {
  return (
    <header
      style={{
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: '#fff',
        flexShrink: 0,
        minHeight: 48,
      }}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--sf-fg-3)',
            display: 'inline-flex',
            padding: 4,
            margin: '-4px 0 -4px -4px',
          }}
        >
          <ArrowLeft size={18} />
        </button>
      ) : (
        <Image
          src="/logo-64.png"
          width={22}
          height={22}
          alt=""
          priority
          style={{ display: 'block' }}
        />
      )}
      <div
        aria-hidden
        style={{ flex: 1, display: 'flex', gap: 4 }}
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background:
                i <= step ? 'var(--sf-accent)' : 'rgba(0,0,0,0.08)',
              transition: 'background 300ms cubic-bezier(0.16,1,0.3,1)',
            }}
          />
        ))}
      </div>
      <OnbMono>
        {step + 1}/4
      </OnbMono>
    </header>
  );
}
