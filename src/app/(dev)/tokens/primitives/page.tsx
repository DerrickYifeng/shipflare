'use client';

/**
 * ShipFlare v2 — Shared Primitives showcase.
 *
 * Phase 2 verification surface. Renders every primitive × variant × size ×
 * meaningful state. Use the theme toggle to verify dark-mode retinting.
 *
 * Route: /tokens/primitives (public, under the (dev) group).
 */

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useState,
} from 'react';

import { AgentCard } from '@/components/ui/agent-card';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { Card, type CardAccent } from '@/components/ui/card';
import { CharCounter } from '@/components/ui/char-counter';
import { EmptyState } from '@/components/ui/empty-state';
import { Ops, type OpsTone } from '@/components/ui/ops';
import { PillCta } from '@/components/ui/pill-cta';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusDot, type StatusDotState } from '@/components/ui/status-dot';
import { ThoughtStream } from '@/components/ui/thought-stream';
import { ToastProvider, useToast } from '@/components/ui/toast';

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'flare', 'ghost', 'ink', 'danger'];
const BUTTON_SIZES: ButtonSize[] = ['sm', 'md', 'lg'];
const BADGE_VARIANTS: BadgeVariant[] = [
  'default',
  'signal',
  'flare',
  'success',
  'warning',
  'danger',
];
const OPS_TONES: OpsTone[] = [
  'dim',
  'ink',
  'signal',
  'flare',
  'success',
  'warning',
  'danger',
  'onDark',
];
const STATUS_STATES: StatusDotState[] = ['active', 'success', 'warning', 'danger', 'idle'];
const CARD_ACCENTS: CardAccent[] = ['signal', 'flare', 'success', 'warning', 'danger'];

const THOUGHT_STEPS = [
  { label: 'Gathering context', detail: 'Pulling brand voice + banned phrases' },
  { label: 'Searching', detail: 'r/programming, r/SideProject, r/indiehackers' },
  { label: 'Scoring', detail: 'Ranking by intent + recency + engagement' },
  { label: 'Drafting', detail: 'Writing candidate replies in your voice' },
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
        <h2 className="sf-h3" style={{ margin: 0 }}>
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

function ButtonMatrix() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-xl)' }}>
      {BUTTON_VARIANTS.map((variant) => (
        <div key={variant}>
          <Ops tone="dim" style={{ display: 'block', marginBottom: 'var(--sf-space-sm)' }}>
            {variant}
          </Ops>
          <div
            style={{
              display: 'flex',
              gap: 'var(--sf-space-md)',
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {BUTTON_SIZES.map((size) => (
              <Button key={size} variant={variant} size={size}>
                Ship it · {size}
              </Button>
            ))}
            <Button variant={variant} disabled>
              Disabled
            </Button>
            <Button
              variant={variant}
              icon={
                <span style={{ width: 14, height: 14, display: 'inline-block' }}>
                  <StatusDot state="active" size={8} />
                </span>
              }
            >
              With icon
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Ops tone="dim" style={{ display: 'block', marginBottom: 'var(--sf-space-sm)' }}>
          block
        </Ops>
        <Button variant="primary" block>
          Full-width button
        </Button>
      </div>
    </div>
  );
}

function PillCtaRow() {
  return (
    <div style={{ display: 'flex', gap: 'var(--sf-space-md)', flexWrap: 'wrap' }}>
      <PillCta variant="primary">Get ShipFlare free</PillCta>
      <PillCta variant="flare">See the demo</PillCta>
    </div>
  );
}

function OpsRow() {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-md)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
      }}
    >
      {OPS_TONES.map((tone) => (
        <div
          key={tone}
          style={{
            padding: 'var(--sf-space-md)',
            background:
              tone === 'onDark' ? 'var(--sf-ink)' : 'var(--sf-paper-raised)',
            borderRadius: 'var(--sf-radius-md)',
            border: '1px solid var(--sf-border-subtle)',
          }}
        >
          <Ops tone={tone}>{tone} · 12px tracked</Ops>
        </div>
      ))}
    </div>
  );
}

function BadgeRow() {
  return (
    <div style={{ display: 'flex', gap: 'var(--sf-space-md)', flexWrap: 'wrap' }}>
      {BADGE_VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
      <Badge variant="signal" mono>
        42 · mono
      </Badge>
      <Badge variant="warning" mono>
        07:23
      </Badge>
    </div>
  );
}

function StatusDotRow() {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-md)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
      }}
    >
      {STATUS_STATES.map((state) => (
        <div
          key={state}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sf-space-sm)',
            padding: 'var(--sf-space-md)',
            background: 'var(--sf-paper-raised)',
            borderRadius: 'var(--sf-radius-md)',
            border: '1px solid var(--sf-border-subtle)',
          }}
        >
          <StatusDot state={state} />
          <Ops tone="dim">{state}</Ops>
        </div>
      ))}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sf-space-sm)',
          padding: 'var(--sf-space-md)',
          background: 'var(--sf-paper-raised)',
          borderRadius: 'var(--sf-radius-md)',
          border: '1px solid var(--sf-border-subtle)',
        }}
      >
        <StatusDot state="active" size={14} />
        <Ops tone="dim">active · size 14</Ops>
      </div>
    </div>
  );
}

function CardRow() {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-lg)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
      }}
    >
      <Card>
        <Ops tone="dim" style={{ display: 'block', marginBottom: 8 }}>
          Default
        </Ops>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-2)',
          }}
        >
          Raised paper surface, no accent stripe.
        </p>
      </Card>
      {CARD_ACCENTS.map((accent) => (
        <Card key={String(accent)} accent={accent}>
          <Ops tone="dim" style={{ display: 'block', marginBottom: 8 }}>
            accent = {String(accent)}
          </Ops>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-2)',
            }}
          >
            Left stripe in <span className="sf-mono">--sf-{String(accent)}</span>.
          </p>
        </Card>
      ))}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-xl)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
      }}
    >
      <Card>
        <Ops tone="dim" style={{ display: 'block', marginBottom: 10 }}>
          Prop sizing
        </Ops>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton width="60%" height={14} />
          <Skeleton width="90%" height={12} />
          <Skeleton width="40%" height={12} />
        </div>
      </Card>
      <Card>
        <Ops tone="dim" style={{ display: 'block', marginBottom: 10 }}>
          className sizing
        </Ops>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-32" />
        </div>
      </Card>
    </div>
  );
}

function EmptyStateRow() {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-lg)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
      }}
    >
      <EmptyState
        title="All caught up on replies."
        hint="We scan every 4h. New threads will show here."
      />
      <EmptyState
        title="Nothing here"
        hint="No items match the current filter."
        action={<Button variant="ghost">Clear filter</Button>}
      />
    </div>
  );
}

function AgentCardRow() {
  // Drive progress from 0 → 0.72 on mount for a cinematic entry.
  const [runningProgress, setRunningProgress] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setRunningProgress(0.72), 200);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-lg)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      }}
    >
      <AgentCard
        name="Nova"
        status="active"
        detail="Searching r/programming for product-market fit threads."
        stats={[
          { value: 48, label: 'Scanned' },
          { value: 3, label: 'Matched' },
        ]}
        cost="0.012"
        elapsed={14}
        progress={runningProgress}
      />
      <AgentCard
        name="Ember"
        status="complete"
        detail="Drafted 3 replies tuned to the brand voice."
        stats={[
          { value: 3, label: 'Drafts' },
          { value: '98%', label: 'On-voice' },
        ]}
        cost="0.041"
        elapsed={22}
      />
      <AgentCard
        name="Sable"
        status="idle"
        detail="Waiting for Drafting to finish the current batch."
      />
      <AgentCard
        name="Arlo"
        status="failed"
        detail="Reddit API timed out after 3 retries."
        cost="0.002"
        elapsed={8}
      />
    </div>
  );
}

function ThoughtStreamRow() {
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setActiveIdx((prev) => (prev + 1) % (THOUGHT_STEPS.length + 1));
    }, 1600);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--sf-space-lg)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
      }}
    >
      <Card padding={24}>
        <ThoughtStream steps={THOUGHT_STEPS} activeIdx={activeIdx} />
      </Card>
      <div
        style={{
          background: 'var(--sf-ink)',
          borderRadius: 'var(--sf-radius-lg)',
          padding: 24,
        }}
      >
        <ThoughtStream steps={THOUGHT_STEPS} activeIdx={activeIdx} onDark />
      </div>
    </div>
  );
}

function CharCounterRow() {
  const [value, setValue] = useState('Hello');
  const max = 40;
  return (
    <div style={{ maxWidth: 560 }}>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type to watch the counter shift colors…"
        style={{
          width: '100%',
          minHeight: 80,
          padding: 'var(--sf-space-md)',
          borderRadius: 'var(--sf-radius-md)',
          border: '1px solid var(--sf-border)',
          background: 'var(--sf-paper-raised)',
          color: 'var(--sf-fg-1)',
          fontFamily: 'inherit',
          fontSize: 'var(--sf-text-sm)',
          lineHeight: 'var(--sf-lh-normal)',
          resize: 'vertical',
        }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginTop: 'var(--sf-space-xs)',
        }}
      >
        <CharCounter count={value.length} max={max} />
      </div>
    </div>
  );
}

function ToastDemoButtons() {
  const { toast, toastWithAction } = useToast();
  return (
    <div style={{ display: 'flex', gap: 'var(--sf-space-md)', flexWrap: 'wrap' }}>
      <Button variant="primary" onClick={() => toast('3 new replies generated', 'success')}>
        Fire success toast
      </Button>
      <Button variant="ghost" onClick={() => toast("Couldn't send — retry", 'error')}>
        Fire error toast
      </Button>
      <Button
        variant="flare"
        onClick={() =>
          toastWithAction({
            message: 'Sent · undo in 5s',
            variant: 'info',
            action: { label: 'Undo', onClick: () => toast('Undone', 'info') },
          })
        }
      >
        Fire toast with undo
      </Button>
    </div>
  );
}

function ThemeHeader({
  dark,
  onToggle,
}: {
  dark: boolean;
  onToggle: () => void;
}) {
  return (
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
        <Ops>ShipFlare v2 · Phase 2</Ops>
        <h1 className="sf-hero" style={{ margin: '8px 0 0', fontSize: 'var(--sf-text-h1)' }}>
          Shared primitives
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
          Twelve ported from the handoff. Toggle dark mode to verify every surface
          retints via <span className="sf-mono">.app-dark</span>.
        </p>
      </div>
      <button
        type="button"
        onClick={onToggle}
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
        <Ops>Theme</Ops>
        <span>{dark ? 'Dark' : 'Light'}</span>
      </button>
    </header>
  );
}

export default function PrimitivesShowcasePage() {
  const [dark, setDark] = useState(false);
  const containerClass = dark ? 'app-dark' : 'app-light';
  const containerStyle: CSSProperties = {
    minHeight: '100vh',
    background: 'var(--sf-paper)',
    color: 'var(--sf-fg-1)',
    fontFamily: 'var(--sf-font-text)',
    fontSize: 'var(--sf-text-base)',
    lineHeight: 'var(--sf-lh-normal)',
    letterSpacing: 'var(--sf-track-normal)',
    transition:
      'background var(--sf-dur-base) var(--sf-ease-swift), color var(--sf-dur-base) var(--sf-ease-swift)',
  };

  return (
    <ToastProvider>
      <div className={containerClass} style={containerStyle}>
        <div
          className="sf-container"
          style={{
            paddingTop: 'var(--sf-space-3xl)',
            paddingBottom: 'var(--sf-space-5xl)',
          }}
        >
          <ThemeHeader dark={dark} onToggle={() => setDark((prev) => !prev)} />

          <Section
            title="Button"
            subtitle="5 variants × 3 sizes. Hover to see the swift-eased transition."
          >
            <ButtonMatrix />
          </Section>

          <Section
            title="PillCta"
            subtitle="Hero-level 48-tall capsule CTA with trailing arrow glyph."
          >
            <PillCtaRow />
          </Section>

          <Section title="Ops" subtitle="Mono uppercase signature label — 12px tracked 0.02em tabular-nums.">
            <OpsRow />
          </Section>

          <Section title="Badge" subtitle="22-tall tinted pill.">
            <BadgeRow />
          </Section>

          <Section title="StatusDot" subtitle="Pulses on active via sf-pulse keyframe.">
            <StatusDotRow />
          </Section>

          <Section title="Card" subtitle="Raised paper surface; accent prop paints the left stripe.">
            <CardRow />
          </Section>

          <Section title="Skeleton" subtitle="sf-shimmer shimmer loop; supports prop or className sizing.">
            <SkeletonRow />
          </Section>

          <Section title="EmptyState" subtitle="Dashed paper-sunken block.">
            <EmptyStateRow />
          </Section>

          <Section
            title="AgentCard"
            subtitle="Signature agent status card; progress bar animates from 0 on mount."
          >
            <AgentCardRow />
          </Section>

          <Section
            title="ThoughtStream"
            subtitle="Numbered progress list on light + dark backgrounds; activeIdx cycles."
          >
            <ThoughtStreamRow />
          </Section>

          <Section title="CharCounter" subtitle="Warn at >90%, danger at >100%.">
            <CharCounterRow />
          </Section>

          <Section
            title="Toast"
            subtitle="Bottom-center, 5s auto-dismiss, undo affordance. Replaces on new fire."
          >
            <ToastDemoButtons />
          </Section>
        </div>
      </div>
    </ToastProvider>
  );
}
