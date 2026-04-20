'use client';

// OnboardingFlow — top-level state machine + responsive shell.
// Phase 11: chrome only. Each stage is stubbed; Phase 12 will implement them.
// Spec: docs/superpowers/specs/2026-04-20-onboarding-frontend-design.md §3-5

import { useEffect, useState, type ReactNode } from 'react';
import type { ExtractedProfile } from '@/types/onboarding';
import { ProgressRail } from './progress-rail';
import { MobileHeader } from './mobile-header';
import { TopChevron } from './top-chevron';
import { WorkArea } from './work-area';
import { StepHeader } from './step-header';
import { ActionBar } from './action-bar';
import { OnbButton } from './_shared/onb-button';
import { ArrowRight } from './icons';

export type Stage =
  | 'source'
  | 'scanning'
  | 'review'
  | 'connect'
  | 'state'
  | 'plan-building'
  | 'plan';

export type ProductState = 'mvp' | 'launching' | 'launched';
export type LaunchChannel = 'producthunt' | 'showhn' | 'both' | 'other';
export type UsersBucket = '<100' | '100-1k' | '1k-10k' | '10k+';

export interface DraftState {
  product: ExtractedProfile | null;
  reviewed: boolean;
  productState: ProductState | null;
  launchDate: string | null;
  launchChannel: LaunchChannel | null;
  usersBucket: UsersBucket | null;
}

const INITIAL_DRAFT: DraftState = {
  product: null,
  reviewed: false,
  productState: null,
  launchDate: null,
  launchChannel: null,
  usersBucket: null,
};

const DESKTOP_BREAKPOINT = 880;

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`);
    const sync = () => setIsDesktop(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);
  return isDesktop;
}

function stepIndexFor(stage: Stage): 0 | 1 | 2 | 3 {
  if (stage === 'source' || stage === 'scanning' || stage === 'review') {
    return 0;
  }
  if (stage === 'connect') return 1;
  if (stage === 'state') return 2;
  return 3;
}

interface OnboardingFlowProps {
  initialStage?: Stage;
}

export function OnboardingFlow({ initialStage = 'source' }: OnboardingFlowProps) {
  const [stage, setStage] = useState<Stage>(initialStage);
  const [draft, setDraft] = useState<DraftState>(INITIAL_DRAFT);
  const isDesktop = useIsDesktop();

  // TODO(phase-12): wire `PUT /api/onboarding/draft` to mirror `draft` to Redis.
  // For now the state lives only in memory.

  const step = stepIndexFor(stage);
  const productName = draft.product?.name || (step >= 1 ? 'ShipFlare' : null);

  const backFor = (current: Stage): (() => void) | null => {
    switch (current) {
      case 'source':
        return null;
      case 'scanning':
        return () => setStage('source');
      case 'review':
        return () => setStage('source');
      case 'connect':
        return () => setStage('review');
      case 'state':
        return () => setStage('connect');
      case 'plan-building':
        return () => setStage('state');
      case 'plan':
        return () => setStage('state');
    }
  };

  const onBack = backFor(stage);
  const chevronLabel =
    stage === 'scanning' || stage === 'plan-building' ? 'Cancel' : 'Back';

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--sf-bg-primary)',
        overflow: 'hidden',
      }}
    >
      {isDesktop && <ProgressRail step={step} productName={productName} />}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {!isDesktop && <MobileHeader step={step} onBack={onBack} />}
        {isDesktop && onBack && (
          <TopChevron onClick={onBack} label={chevronLabel} />
        )}
        <WorkArea
          maxWidth={isDesktop ? 600 : 340}
          animationKey={stage}
        >
          <StagePlaceholder
            stage={stage}
            draft={draft}
            onAdvance={(next, patch) => {
              if (patch) setDraft((prev) => ({ ...prev, ...patch }));
              setStage(next);
            }}
          />
        </WorkArea>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage placeholders (Phase 12 replaces each with the real component).
// Every placeholder has a primary CTA so the orchestrator routing is testable.
// ---------------------------------------------------------------------------

interface StagePlaceholderProps {
  stage: Stage;
  draft: DraftState;
  onAdvance: (next: Stage, patch?: Partial<DraftState>) => void;
}

function StagePlaceholder({ stage, draft, onAdvance }: StagePlaceholderProps) {
  switch (stage) {
    case 'source':
      return (
        <Placeholder
          kicker="Step 1 · Source"
          title="Add your product"
          sub="Point ShipFlare at your repo or site and we'll extract the essentials."
          primaryLabel="Start scan"
          onPrimary={() =>
            onAdvance('scanning', {
              product: {
                url: 'https://shipflare.dev',
                name: 'ShipFlare',
                description: 'AI marketing autopilot for indie developers.',
                keywords: ['ai agents', 'reddit marketing', 'indie dev tools'],
                valueProp: '',
                ogImage: null,
                seoAudit: null,
              },
            })
          }
        />
      );
    case 'scanning':
      return (
        <Placeholder
          kicker="Step 1 · Scanning"
          title="Reading your product…"
          sub="Six agents are extracting name, description, voice, and keywords."
          primaryLabel="Continue"
          onPrimary={() => onAdvance('review')}
        />
      );
    case 'review':
      return (
        <Placeholder
          kicker="Step 1 · Review"
          title="Here's what we found"
          sub="Phase 12 will render the six-field review form with staggered reveal."
          primaryLabel="Looks good, continue"
          onPrimary={() =>
            onAdvance('connect', {
              reviewed: true,
            })
          }
        />
      );
    case 'connect':
      return (
        <Placeholder
          kicker="Step 2 · Channels"
          title="Connect your accounts"
          sub="Reddit + X OAuth cards go here. You approve every post."
          primaryLabel="Next · Where's your product at?"
          onPrimary={() => onAdvance('state')}
        />
      );
    case 'state':
      return (
        <Placeholder
          kicker="Step 3 · Product state"
          title="Where's your product at?"
          sub="Pick the card that matches — MVP / launching / launched."
          primaryLabel="Generate plan"
          onPrimary={() =>
            onAdvance('plan-building', {
              productState: draft.productState ?? 'launching',
            })
          }
        />
      );
    case 'plan-building':
      return (
        <Placeholder
          kicker="Step 4 · Building plan"
          title="Calibrating your plan"
          sub="Six agents are shaping a plan around your product state."
          primaryLabel="Continue"
          onPrimary={() => onAdvance('plan')}
        />
      );
    case 'plan':
      return (
        <Placeholder
          kicker="Step 4 · Plan"
          title="Your launch plan"
          sub="Three tabs — About, Timeline, First week — land here in Phase 12."
          primaryLabel="Launch the agents"
          onPrimary={() => {
            // TODO(phase-12): POST /api/onboarding/commit, then navigate.
            window.location.href = '/today?from=onboarding';
          }}
        />
      );
  }
}

interface PlaceholderProps {
  kicker: string;
  title: string;
  sub: string;
  primaryLabel: string;
  onPrimary: () => void;
}

function Placeholder({
  kicker,
  title,
  sub,
  primaryLabel,
  onPrimary,
}: PlaceholderProps) {
  return (
    <>
      <StepHeader kicker={kicker} title={title} sub={sub} />
      <StageStubCard />
      <ActionBar
        primary={
          <OnbButton size="lg" variant="primary" onClick={onPrimary}>
            {primaryLabel}
            <ArrowRight size={14} />
          </OnbButton>
        }
      />
    </>
  );
}

function StageStubCard(): ReactNode {
  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 12,
        padding: '22px 20px',
        boxShadow: 'var(--sf-shadow-card)',
        border: '1px solid var(--sf-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--sf-font-mono)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '-0.08px',
          textTransform: 'uppercase',
          color: 'var(--sf-fg-4)',
        }}
      >
        Phase 11 placeholder
      </span>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          lineHeight: 1.5,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-2)',
        }}
      >
        This stage renders real content in Phase 12. The chrome, primitives,
        copy, and routing are already in place — the primary button below
        advances the state machine so navigation can be verified end-to-end.
      </p>
    </div>
  );
}
