'use client';

/**
 * ShipFlare v2 — Design Tokens Cheat-Sheet
 *
 * Verification surface for Phase 1. Renders every token registered in
 * `globals.css` (colors, type scale, spacing, radius, shadow, motion)
 * in both light and dark modes via the `.app-dark` container toggle.
 *
 * Route: /tokens (not auth-gated, under (dev) group).
 */

import { useState, type CSSProperties, type ReactNode } from 'react';

type Swatch = {
  name: string;
  value: string;
  description?: string;
};

const NEUTRAL_COLORS: Swatch[] = [
  { name: '--sf-ink', value: 'oklch(14% 0.020 265)', description: 'near-black hero bg' },
  { name: '--sf-ink-raised', value: 'oklch(20% 0.024 265)', description: 'elevated on dark' },
  { name: '--sf-paper', value: 'oklch(97.5% 0.010 75)', description: 'warm cream canvas' },
  { name: '--sf-paper-raised', value: 'oklch(100% 0 0)', description: 'card on paper' },
  { name: '--sf-paper-sunken', value: 'oklch(94% 0.012 70)', description: 'peach rail / input bg' },
];

const FG_LIGHT: Swatch[] = [
  { name: '--sf-fg-1', value: 'oklch(18% 0.020 265)' },
  { name: '--sf-fg-2', value: 'oklch(35% 0.016 265)' },
  { name: '--sf-fg-3', value: 'oklch(52% 0.012 265)' },
  { name: '--sf-fg-4', value: 'oklch(65% 0.008 265)' },
];

const FG_DARK: Swatch[] = [
  { name: '--sf-fg-on-dark-1', value: 'oklch(98% 0.004 85)' },
  { name: '--sf-fg-on-dark-2', value: 'oklch(82% 0.008 85)' },
  { name: '--sf-fg-on-dark-3', value: 'oklch(65% 0.010 260)' },
  { name: '--sf-fg-on-dark-4', value: 'oklch(50% 0.012 260)' },
];

const BORDERS: Swatch[] = [
  { name: '--sf-border', value: 'oklch(18% 0.025 265 / 0.12)' },
  { name: '--sf-border-subtle', value: 'oklch(18% 0.025 265 / 0.06)' },
  { name: '--sf-border-strong', value: 'oklch(18% 0.025 265 / 0.18)' },
  { name: '--sf-border-on-dark', value: 'oklch(98% 0.004 85 / 0.10)' },
];

const SIGNAL: Swatch[] = [
  { name: '--sf-signal', value: 'oklch(58% 0.22 258)' },
  { name: '--sf-signal-hover', value: 'oklch(63% 0.22 258)' },
  { name: '--sf-signal-ink', value: 'oklch(42% 0.22 258)' },
  { name: '--sf-signal-bright', value: 'oklch(74% 0.19 258)' },
  { name: '--sf-signal-tint', value: 'oklch(94% 0.05 258)' },
  { name: '--sf-signal-glow', value: 'oklch(58% 0.22 258 / 0.18)' },
];

const FLARE: Swatch[] = [
  { name: '--sf-flare', value: 'oklch(74% 0.19 52)' },
  { name: '--sf-flare-hover', value: 'oklch(78% 0.19 52)' },
  { name: '--sf-flare-ink', value: 'oklch(50% 0.17 48)' },
  { name: '--sf-flare-tint', value: 'oklch(94% 0.07 65)' },
  { name: '--sf-flare-glow', value: 'oklch(74% 0.19 52 / 0.20)' },
];

const SEMANTIC: Swatch[] = [
  { name: '--sf-success', value: 'oklch(68% 0.17 152)' },
  { name: '--sf-success-ink', value: 'oklch(48% 0.14 152)' },
  { name: '--sf-success-tint', value: 'oklch(95% 0.04 152)' },
  { name: '--sf-warning', value: 'oklch(76% 0.16 82)' },
  { name: '--sf-warning-ink', value: 'oklch(52% 0.14 70)' },
  { name: '--sf-warning-tint', value: 'oklch(95% 0.04 82)' },
  { name: '--sf-danger', value: 'oklch(62% 0.22 25)' },
  { name: '--sf-danger-ink', value: 'oklch(48% 0.22 25)' },
  { name: '--sf-danger-tint', value: 'oklch(95% 0.04 25)' },
];

const CATEGORICAL: Swatch[] = [
  { name: '--sf-cat-1', value: 'oklch(62% 0.19 255)', description: 'signal indigo' },
  { name: '--sf-cat-2', value: 'oklch(62% 0.19 190)', description: 'teal' },
  { name: '--sf-cat-3', value: 'oklch(62% 0.19 140)', description: 'green' },
  { name: '--sf-cat-4', value: 'oklch(62% 0.19 48)', description: 'amber' },
  { name: '--sf-cat-5', value: 'oklch(62% 0.19 10)', description: 'coral' },
  { name: '--sf-cat-6', value: 'oklch(62% 0.19 310)', description: 'violet' },
];

const SPACING: { name: string; value: string; px: number }[] = [
  { name: '--sf-space-2xs', value: '2px', px: 2 },
  { name: '--sf-space-xs', value: '4px', px: 4 },
  { name: '--sf-space-sm', value: '8px', px: 8 },
  { name: '--sf-space-md', value: '12px', px: 12 },
  { name: '--sf-space-base', value: '16px', px: 16 },
  { name: '--sf-space-lg', value: '20px', px: 20 },
  { name: '--sf-space-xl', value: '24px', px: 24 },
  { name: '--sf-space-2xl', value: '32px', px: 32 },
  { name: '--sf-space-3xl', value: '48px', px: 48 },
  { name: '--sf-space-4xl', value: '72px', px: 72 },
  { name: '--sf-space-5xl', value: '120px', px: 120 },
];

const RADII: { name: string; value: string }[] = [
  { name: '--sf-radius-sm', value: '6px' },
  { name: '--sf-radius-md', value: '10px' },
  { name: '--sf-radius-lg', value: '16px' },
  { name: '--sf-radius-pill', value: '9999px' },
];

const SHADOWS: { name: string; var: string }[] = [
  { name: '--sf-shadow-sm', var: 'var(--sf-shadow-sm)' },
  { name: '--sf-shadow-md', var: 'var(--sf-shadow-md)' },
  { name: '--sf-shadow-lg', var: 'var(--sf-shadow-lg)' },
  { name: '--sf-shadow-focus', var: 'var(--sf-shadow-focus)' },
  { name: '--sf-shadow-glow-signal', var: 'var(--sf-shadow-glow-signal)' },
  { name: '--sf-shadow-glow-flare', var: 'var(--sf-shadow-glow-flare)' },
];

const TYPE_SCALE: { name: string; size: string }[] = [
  { name: '--sf-text-hero', size: '64px' },
  { name: '--sf-text-h1', size: '44px' },
  { name: '--sf-text-h2', size: '32px' },
  { name: '--sf-text-h3', size: '22px' },
  { name: '--sf-text-lg', size: '18px' },
  { name: '--sf-text-base', size: '16px' },
  { name: '--sf-text-sm', size: '14px' },
  { name: '--sf-text-xs', size: '12px' },
  { name: '--sf-text-2xs', size: '10px' },
];

const DURATIONS: { name: string; value: string }[] = [
  { name: '--sf-dur-fast', value: '150ms' },
  { name: '--sf-dur-base', value: '220ms' },
  { name: '--sf-dur-slow', value: '320ms' },
  { name: '--sf-dur-entrance', value: '560ms' },
];

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        padding: 'var(--sf-space-2xl) 0',
        borderBottom: '1px solid var(--sf-border-subtle)',
      }}
    >
      <header style={{ marginBottom: 'var(--sf-space-xl)' }}>
        <h2
          style={{
            margin: 0,
            fontFamily: 'var(--sf-font-display)',
            fontSize: 'var(--sf-text-h3)',
            fontWeight: 600,
            lineHeight: 'var(--sf-lh-snug)',
            letterSpacing: 'var(--sf-track-normal)',
            color: 'var(--sf-fg-1)',
          }}
        >
          {title}
        </h2>
        {subtitle ? (
          <p
            style={{
              margin: '6px 0 0',
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-3)',
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function ColorSwatch({
  swatch,
  onDark = false,
}: {
  swatch: Swatch;
  onDark?: boolean;
}) {
  const swatchStyle: CSSProperties = {
    background: `var(${swatch.name})`,
    height: 80,
    borderRadius: 'var(--sf-radius-md)',
    border: onDark
      ? '1px solid var(--sf-border-on-dark)'
      : '1px solid var(--sf-border-subtle)',
  };
  return (
    <div>
      <div style={swatchStyle} />
      <div style={{ marginTop: 'var(--sf-space-sm)' }}>
        <div className="sf-ops" style={{ color: 'var(--sf-fg-2)' }}>
          {swatch.name}
        </div>
        <div
          style={{
            fontFamily: 'var(--sf-font-mono)',
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-4)',
            marginTop: 2,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {swatch.value}
        </div>
        {swatch.description ? (
          <div
            style={{
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              marginTop: 2,
            }}
          >
            {swatch.description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SwatchGrid({ items, onDark = false }: { items: Swatch[]; onDark?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-base)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
      }}
    >
      {items.map((s) => (
        <ColorSwatch key={s.name} swatch={s} onDark={onDark} />
      ))}
    </div>
  );
}

function MotionDemo() {
  const [tick, setTick] = useState(0);
  return (
    <div>
      <button
        onClick={() => setTick((t) => t + 1)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '8px 16px',
          borderRadius: 'var(--sf-radius-md)',
          background: 'var(--sf-signal)',
          color: 'var(--sf-fg-on-dark-1)',
          border: 'none',
          fontFamily: 'var(--sf-font-text)',
          fontSize: 'var(--sf-text-sm)',
          fontWeight: 500,
          cursor: 'pointer',
          boxShadow: 'var(--sf-shadow-glow-signal)',
        }}
      >
        Animate with --sf-ease-swift
      </button>

      <div
        style={{
          marginTop: 'var(--sf-space-lg)',
          position: 'relative',
          height: 72,
          background: 'var(--sf-paper-sunken)',
          borderRadius: 'var(--sf-radius-md)',
          overflow: 'hidden',
        }}
      >
        <div
          key={tick}
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            width: 48,
            height: 48,
            marginTop: -24,
            borderRadius: 'var(--sf-radius-sm)',
            background: 'linear-gradient(135deg, var(--sf-signal), var(--sf-flare))',
            transform: `translateX(${tick ? 'calc(100% * 6)' : '0'})`,
            transition:
              'transform var(--sf-dur-entrance) var(--sf-ease-swift)',
          }}
        />
      </div>

      <div
        style={{
          marginTop: 'var(--sf-space-lg)',
          display: 'grid',
          gap: 'var(--sf-space-md)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        }}
      >
        {[
          { label: 'sf-fade-in', animation: 'sf-fade-in 1s var(--sf-ease-swift) infinite alternate' },
          { label: 'sf-slide-up', animation: 'sf-slide-up 1s var(--sf-ease-swift) infinite alternate' },
          { label: 'sf-pulse', animation: 'sf-pulse 1.5s var(--sf-ease-smooth) infinite' },
          { label: 'sf-shimmer', animation: 'sf-shimmer 1.4s linear infinite' },
          { label: 'sf-idle-bob', animation: 'sf-idle-bob 2.2s var(--sf-ease-smooth) infinite' },
          { label: 'sf-walk', animation: 'sf-walk 0.8s var(--sf-ease-smooth) infinite' },
        ].map((d) => (
          <div
            key={d.label}
            style={{
              background: 'var(--sf-paper-raised)',
              border: '1px solid var(--sf-border-subtle)',
              borderRadius: 'var(--sf-radius-md)',
              padding: 'var(--sf-space-md)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--sf-space-md)',
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 'var(--sf-radius-sm)',
                background:
                  d.label === 'sf-shimmer'
                    ? 'linear-gradient(90deg, var(--sf-paper-sunken), var(--sf-signal-tint), var(--sf-paper-sunken))'
                    : 'var(--sf-signal)',
                backgroundSize: d.label === 'sf-shimmer' ? '200% 100%' : undefined,
                animation: d.animation,
              }}
            />
            <span className="sf-ops">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TokensPage() {
  const [dark, setDark] = useState(false);

  const containerClass = dark ? 'app-dark' : 'app-light';

  return (
    <div
      className={containerClass}
      style={{
        minHeight: '100vh',
        background: 'var(--sf-paper)',
        color: 'var(--sf-fg-1)',
        fontFamily: 'var(--sf-font-text)',
        fontSize: 'var(--sf-text-base)',
        lineHeight: 'var(--sf-lh-normal)',
        letterSpacing: 'var(--sf-track-normal)',
        transition: 'background var(--sf-dur-base) var(--sf-ease-swift), color var(--sf-dur-base) var(--sf-ease-swift)',
      }}
    >
      <div className="sf-container" style={{ paddingTop: 'var(--sf-space-3xl)', paddingBottom: 'var(--sf-space-5xl)' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 'var(--sf-space-xl)',
            flexWrap: 'wrap',
            paddingBottom: 'var(--sf-space-2xl)',
            borderBottom: '1px solid var(--sf-border)',
          }}
        >
          <div>
            <div className="sf-ops">ShipFlare v2 · Phase 1</div>
            <h1
              className="sf-hero"
              style={{
                margin: '8px 0 0',
                fontSize: 'var(--sf-text-h1)',
                color: 'var(--sf-fg-1)',
              }}
            >
              Design tokens
            </h1>
            <p
              style={{
                maxWidth: 'var(--sf-max-width-prose)',
                marginTop: 'var(--sf-space-sm)',
                color: 'var(--sf-fg-2)',
                fontSize: 'var(--sf-text-lg)',
                lineHeight: 'var(--sf-lh-normal)',
              }}
            >
              Every color, type, spacing, radius, shadow, and motion token from the v2 handoff.
              Toggle dark to verify the <span className="sf-mono">.app-dark</span> remap.
            </p>
          </div>

          <button
            onClick={() => setDark((d) => !d)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--sf-space-sm)',
              padding: '10px 16px',
              borderRadius: 'var(--sf-radius-pill)',
              border: '1px solid var(--sf-border-strong)',
              background: 'var(--sf-paper-raised)',
              color: 'var(--sf-fg-1)',
              fontFamily: 'var(--sf-font-text)',
              fontSize: 'var(--sf-text-sm)',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all var(--sf-dur-base) var(--sf-ease-swift)',
            }}
          >
            <span className="sf-ops" style={{ color: 'var(--sf-fg-3)' }}>
              Theme
            </span>
            <span>{dark ? 'Dark' : 'Light'}</span>
          </button>
        </header>

        <Section title="Neutrals" subtitle="Cool-tinted surfaces, not pure black/white.">
          <SwatchGrid items={NEUTRAL_COLORS} onDark={dark} />
        </Section>

        <Section title="Foreground (light)">
          <SwatchGrid items={FG_LIGHT} onDark={dark} />
        </Section>

        <Section title="Foreground (on dark)">
          <SwatchGrid items={FG_DARK} onDark={dark} />
        </Section>

        <Section title="Borders">
          <SwatchGrid items={BORDERS} onDark={dark} />
        </Section>

        <Section title="Signal — primary accent" subtitle="Electric indigo, used for primary CTAs, active nav, links on dark.">
          <SwatchGrid items={SIGNAL} onDark={dark} />
        </Section>

        <Section title="Flare — secondary accent" subtitle="Warm amber, used for secondary CTAs and highlights.">
          <SwatchGrid items={FLARE} onDark={dark} />
        </Section>

        <Section title="Semantic — success / warning / danger">
          <SwatchGrid items={SEMANTIC} onDark={dark} />
        </Section>

        <Section title="Categorical — data-viz & agent chips" subtitle="Same L & C, only H varies — perceptually uniform.">
          <SwatchGrid items={CATEGORICAL} onDark={dark} />
        </Section>

        <Section title="Type scale" subtitle="Geist display + text. Mono: Geist Mono.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-md)' }}>
            {TYPE_SCALE.map((t) => (
              <div
                key={t.name}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--sf-space-xl)',
                  paddingBottom: 'var(--sf-space-md)',
                  borderBottom: '1px solid var(--sf-border-subtle)',
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--sf-font-display)',
                    fontSize: `var(${t.name})`,
                    fontWeight: 600,
                    lineHeight: 'var(--sf-lh-tight)',
                    letterSpacing: 'var(--sf-track-tight)',
                    color: 'var(--sf-fg-1)',
                    flex: '1 1 auto',
                  }}
                >
                  ShipFlare ships.
                </div>
                <div style={{ minWidth: 160, textAlign: 'right' }}>
                  <div className="sf-ops" style={{ color: 'var(--sf-fg-2)' }}>
                    {t.name}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--sf-font-mono)',
                      fontSize: 'var(--sf-text-xs)',
                      color: 'var(--sf-fg-4)',
                      marginTop: 2,
                    }}
                  >
                    {t.size}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 'var(--sf-space-2xl)',
              padding: 'var(--sf-space-lg)',
              background: 'var(--sf-paper-raised)',
              borderRadius: 'var(--sf-radius-md)',
              border: '1px solid var(--sf-border-subtle)',
            }}
          >
            <span className="sf-ops">Signature · sf-ops 12px mono tracked 0.02em tabular-nums</span>
          </div>
        </Section>

        <Section title="Spacing" subtitle="2xs → 5xl (2 → 120px).">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-sm)' }}>
            {SPACING.map((s) => (
              <div
                key={s.name}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--sf-space-md)' }}
              >
                <div style={{ minWidth: 160 }} className="sf-ops">
                  {s.name}
                </div>
                <div
                  style={{
                    width: s.px,
                    height: 16,
                    background: 'var(--sf-signal)',
                    borderRadius: 2,
                  }}
                />
                <div
                  style={{
                    fontFamily: 'var(--sf-font-mono)',
                    fontSize: 'var(--sf-text-xs)',
                    color: 'var(--sf-fg-3)',
                  }}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radius">
          <div
            style={{
              display: 'grid',
              gap: 'var(--sf-space-base)',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            }}
          >
            {RADII.map((r) => (
              <div key={r.name}>
                <div
                  style={{
                    height: 80,
                    background: 'var(--sf-signal-tint)',
                    borderRadius: r.value,
                    border: '1px solid var(--sf-border-subtle)',
                  }}
                />
                <div style={{ marginTop: 'var(--sf-space-sm)' }}>
                  <div className="sf-ops">{r.name}</div>
                  <div
                    style={{
                      fontFamily: 'var(--sf-font-mono)',
                      fontSize: 'var(--sf-text-xs)',
                      color: 'var(--sf-fg-3)',
                    }}
                  >
                    {r.value}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Shadow">
          <div
            style={{
              display: 'grid',
              gap: 'var(--sf-space-xl)',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            }}
          >
            {SHADOWS.map((s) => (
              <div key={s.name}>
                <div
                  style={{
                    height: 96,
                    background: 'var(--sf-paper-raised)',
                    borderRadius: 'var(--sf-radius-md)',
                    boxShadow: s.var,
                  }}
                />
                <div className="sf-ops" style={{ marginTop: 'var(--sf-space-sm)' }}>
                  {s.name}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Motion" subtitle="Signature ease: cubic-bezier(0.16, 1, 0.3, 1).">
          <div
            style={{
              display: 'grid',
              gap: 'var(--sf-space-sm)',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              marginBottom: 'var(--sf-space-xl)',
            }}
          >
            {DURATIONS.map((d) => (
              <div
                key={d.name}
                style={{
                  padding: 'var(--sf-space-md)',
                  background: 'var(--sf-paper-raised)',
                  borderRadius: 'var(--sf-radius-md)',
                  border: '1px solid var(--sf-border-subtle)',
                }}
              >
                <div className="sf-ops">{d.name}</div>
                <div
                  style={{
                    fontFamily: 'var(--sf-font-mono)',
                    fontSize: 'var(--sf-text-sm)',
                    color: 'var(--sf-fg-2)',
                    marginTop: 4,
                  }}
                >
                  {d.value}
                </div>
              </div>
            ))}
          </div>
          <MotionDemo />
        </Section>

        <Section title="Dark-mode remap" subtitle="Toggle the theme button above — every surface retints via .app-dark CSS vars.">
          <p style={{ margin: 0, color: 'var(--sf-fg-3)', fontSize: 'var(--sf-text-sm)' }}>
            Current container: <span className="sf-mono">.{containerClass}</span>
          </p>
        </Section>
      </div>
    </div>
  );
}
