// Stage 6 — Plan building. Reuses SixStepAnimator while POST /api/onboarding/plan
// runs in parallel. 45s timeout → error state with "Continue with manual plan"
// fallback.

'use client';

import { useEffect, useRef, useState } from 'react';
import { OnbMono } from './_shared/onb-mono';
import { SixStepAnimator } from './_shared/six-step-animator';
import { OnbButton } from './_shared/onb-button';
import { COPY } from './_copy';
import type {
  StrategicPath,
  TacticalPlan,
} from '@/agents/schemas';
import type { DraftState, ProductState } from './OnboardingFlow';

const PLAN_TIMEOUT_MS = 45_000;

interface PlanRequest {
  product: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
    category:
      | 'dev_tool'
      | 'saas'
      | 'consumer'
      | 'creator_tool'
      | 'agency'
      | 'ai_app'
      | 'other';
    targetAudience: string | null;
  };
  channels: Array<'x' | 'reddit' | 'email'>;
  state: ProductState;
  launchDate?: string | null;
  launchedAt?: string | null;
  voiceProfile?: string | null;
}

interface PlanResponse {
  path: StrategicPath;
  plan: TacticalPlan;
}

interface StagePlanBuildingProps {
  draft: DraftState;
  /** Channels already connected from /api/channels. */
  connectedChannels: Array<'x' | 'reddit' | 'email'>;
  onGenerated: (response: PlanResponse) => void;
  onCancel: () => void;
  onFallback: () => void;
}

function toIsoOrNull(dateYmd: string | null): string | null {
  if (!dateYmd) return null;
  try {
    return new Date(`${dateYmd}T00:00:00.000Z`).toISOString();
  } catch {
    return null;
  }
}

export function StagePlanBuilding({
  draft,
  connectedChannels,
  onGenerated,
  onCancel,
  onFallback,
}: StagePlanBuildingProps) {
  const [realCallComplete, setRealCallComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseRef = useRef<PlanResponse | null>(null);
  const stateLabel = draft.productState ?? 'launching';

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('timeout', 'AbortError')),
      PLAN_TIMEOUT_MS,
    );

    (async () => {
      try {
        const body: PlanRequest = {
          product: {
            name: draft.product?.name ?? '',
            description: draft.product?.description ?? '',
            valueProp: draft.product?.valueProp || null,
            keywords: draft.product?.keywords ?? [],
            category: 'dev_tool',
            targetAudience: draft.audience?.trim() || null,
          },
          channels:
            connectedChannels.length > 0 ? connectedChannels : ['reddit', 'x'],
          state: draft.productState ?? 'launching',
          launchDate: toIsoOrNull(draft.launchDate),
          voiceProfile: draft.voice || null,
        };

        const res = await fetch('/api/onboarding/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(errBody.detail || errBody.error || `${res.status}`);
        }
        const json = (await res.json()) as PlanResponse;
        responseRef.current = json;
        setRealCallComplete(true);
      } catch (err) {
        if (controller.signal.aborted) {
          setError(COPY.stage6.timeoutMessage);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timeout);
      }
    })();

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [draft, connectedChannels]);

  const handleComplete = () => {
    const r = responseRef.current;
    if (r) onGenerated(r);
  };

  const steps = COPY.stage6.steps.map((s) => ({
    ...s,
    target: s.target.replace('{STATE}', stateLabel),
  }));

  return (
    <div>
      <OnbMono>{COPY.stage6.kicker}</OnbMono>
      <h2
        style={{
          margin: '12px 0 8px',
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.1,
          letterSpacing: '-0.28px',
          color: 'var(--sf-fg-1)',
        }}
      >
        {COPY.stage6.title}
      </h2>
      <p
        style={{
          margin: '0 0 24px',
          fontSize: 15,
          lineHeight: 1.47,
          letterSpacing: '-0.224px',
          color: 'var(--sf-fg-2)',
        }}
      >
        {COPY.stage6.subPrefix}{' '}
        <span
          style={{
            fontFamily: 'var(--sf-font-mono)',
            fontSize: 13,
            color: 'var(--sf-accent)',
            textTransform: 'uppercase',
            letterSpacing: '-0.08px',
          }}
        >
          {stateLabel}
        </span>{' '}
        {COPY.stage6.subSuffix}
      </p>

      <SixStepAnimator
        steps={steps}
        agentName={COPY.stage6.agentName}
        cancelLabel="Cancel"
        onCancel={onCancel}
        realCallComplete={realCallComplete}
        realCallError={error}
        onComplete={handleComplete}
      />

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: '14px 16px',
            background: 'var(--sf-error-light)',
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: 'var(--sf-error-ink)',
              letterSpacing: '-0.16px',
            }}
          >
            {error}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <OnbButton variant="secondary" onClick={onCancel}>
              {COPY.stage6.retryCta}
            </OnbButton>
            <OnbButton variant="ghost" onClick={onFallback}>
              {COPY.stage6.fallbackCta}
            </OnbButton>
          </div>
        </div>
      )}
    </div>
  );
}
