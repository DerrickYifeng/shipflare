// ProgressRail — 360px dark rail shown on desktop (≥880px).
// Frontend spec §3.2: header + kicker/title/detail + 4-step nav + product-name
// card (step ≥ 1) + "6 agents ready" footer.

import Image from 'next/image';
import { Check } from './icons';
import { OnbMono } from './_shared/onb-mono';
import { COPY } from './_copy';

interface ProgressRailProps {
  step: 0 | 1 | 2 | 3;
  productName?: string | null;
}

export function ProgressRail({ step, productName }: ProgressRailProps) {
  const steps = COPY.rail.steps;
  const active = steps[step] ?? steps[0];
  return (
    <aside
      aria-label="Onboarding progress"
      style={{
        width: 360,
        flexShrink: 0,
        background: 'var(--sf-bg-dark)',
        color: 'var(--sf-fg-on-dark-1)',
        padding: '32px 40px 40px',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Image
          src="/logo-64.png"
          width={24}
          height={24}
          alt=""
          priority
          style={{ display: 'block' }}
        />
        <span
          style={{
            fontSize: 17,
            fontWeight: 600,
            letterSpacing: '-0.374px',
          }}
        >
          {COPY.rail.header}
        </span>
      </div>

      <div style={{ marginTop: 56 }}>
        <OnbMono color="var(--sf-fg-on-dark-4)">{COPY.rail.meta(step)}</OnbMono>
        <h1
          style={{
            margin: '14px 0 0',
            fontSize: 30,
            fontWeight: 600,
            lineHeight: 1.12,
            letterSpacing: '-0.28px',
          }}
        >
          {active.label}
        </h1>
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 14,
            lineHeight: 1.5,
            letterSpacing: '-0.16px',
            color: 'var(--sf-fg-on-dark-3)',
            maxWidth: 260,
          }}
        >
          {active.detail}
        </p>
      </div>

      <nav
        aria-label="Setup steps"
        style={{
          marginTop: 40,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {steps.map((item, i) => {
          const state: 'done' | 'active' | 'todo' =
            i < step ? 'done' : i === step ? 'active' : 'todo';
          return (
            <div
              key={item.label}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                padding: '8px 0',
              }}
            >
              <StepDot state={state} n={i + 1} />
              <div style={{ paddingTop: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    letterSpacing: '-0.16px',
                    color:
                      state === 'todo'
                        ? 'var(--sf-fg-on-dark-4)'
                        : 'var(--sf-fg-on-dark-1)',
                    fontWeight: state === 'active' ? 500 : 400,
                    transition: 'color 300ms cubic-bezier(0.16,1,0.3,1)',
                  }}
                >
                  {item.label}
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', paddingTop: 24 }}>
        {productName && step >= 1 && (
          <div
            style={{
              marginBottom: 14,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <OnbMono
              color="var(--sf-fg-on-dark-4)"
              style={{ fontSize: 10 }}
            >
              Product
            </OnbMono>
            <div
              style={{
                fontSize: 13,
                letterSpacing: '-0.16px',
                marginTop: 2,
                color: 'var(--sf-fg-on-dark-1)',
              }}
            >
              {productName}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--sf-success)',
              animation: 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
            }}
          />
          <OnbMono color="var(--sf-fg-on-dark-4)">
            {COPY.rail.footerStatus}
          </OnbMono>
        </div>
      </div>
    </aside>
  );
}

interface StepDotProps {
  state: 'done' | 'active' | 'todo';
  n: number;
}

function StepDot({ state, n }: StepDotProps) {
  if (state === 'done') {
    return (
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'var(--sf-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <Check size={12} />
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: 'rgba(0,113,227,0.18)',
          border: '1.5px solid var(--sf-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--sf-accent)',
            animation: 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
          }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        border: '1.5px solid rgba(255,255,255,0.16)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        color: 'rgba(255,255,255,0.36)',
        fontFamily: 'var(--sf-font-mono)',
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}
