// StateCard — Stage 5 radio card. Selected state draws a 2px accent ring via
// box-shadow. 22×22 radio circle on the left, kicker + title + sub + plan row.

import { useState } from 'react';
import { Check } from '../icons';
import { OnbMono } from './onb-mono';

export interface StateCardOption {
  readonly id: string;
  readonly kicker: string;
  readonly title: string;
  readonly sub: string;
  readonly plan: string;
  readonly planDetail: string;
  readonly recommended?: boolean;
}

interface StateCardProps {
  option: StateCardOption;
  selected: boolean;
  onSelect: () => void;
  recommendedLabel: string;
}

export function StateCard({
  option,
  selected,
  onSelect,
  recommendedLabel,
}: StateCardProps) {
  const [hover, setHover] = useState(false);
  const boxShadow = selected
    ? '0 0 0 2px var(--sf-accent), var(--sf-shadow-card)'
    : hover
      ? 'var(--sf-shadow-card-hover)'
      : 'var(--sf-shadow-card)';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: 'left',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        background: 'var(--sf-bg-secondary)',
        padding: '18px 20px',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        boxShadow,
        transition: 'box-shadow 200ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          flexShrink: 0,
          background: selected ? 'var(--sf-accent)' : 'transparent',
          border: selected ? 'none' : '1.5px solid rgba(0,0,0,0.16)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        {selected && <Check size={12} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <OnbMono color={selected ? 'var(--sf-accent)' : 'var(--sf-fg-4)'}>
            {option.kicker}
          </OnbMono>
          {option.recommended && !selected && (
            <span
              style={{
                padding: '1px 6px',
                borderRadius: 4,
                background: 'var(--sf-accent-light)',
                color: 'var(--sf-accent)',
                fontSize: 10,
                fontFamily: 'var(--sf-font-mono)',
                letterSpacing: '-0.08px',
                textTransform: 'uppercase',
                fontWeight: 500,
              }}
            >
              {recommendedLabel}
            </span>
          )}
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-0.224px',
            color: 'var(--sf-fg-1)',
          }}
        >
          {option.title}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 13,
            lineHeight: 1.47,
            letterSpacing: '-0.16px',
            color: 'var(--sf-fg-3)',
          }}
        >
          {option.sub}
        </div>
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid rgba(0,0,0,0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <OnbMono>Plan →</OnbMono>
          <span
            style={{
              fontSize: 12,
              letterSpacing: '-0.12px',
              color: 'var(--sf-fg-2)',
            }}
          >
            <strong style={{ color: 'var(--sf-fg-1)', fontWeight: 600 }}>
              {option.plan}.
            </strong>{' '}
            {option.planDetail}
          </span>
        </div>
      </div>
    </button>
  );
}
