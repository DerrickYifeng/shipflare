// Stage 6 — Plan building. Renders a /team-style chat transcript while
// POST /api/onboarding/plan streams SSE events. Advances on
// `strategic_done` with the strategic path only — tactical drafting is
// deferred to a background worker kicked off by /api/onboarding/commit,
// with progress shown on /today. 180s timeout → error state with
// "Continue with manual plan" fallback.

'use client';

import { useEffect, useRef, useState } from 'react';
import { OnbMono } from './_shared/onb-mono';
import { OnbButton } from './_shared/onb-button';
import { SyntheticChatConversation } from './_shared/synthetic-chat-conversation';
import {
  synthesizeStrategyConversation,
  type ToolProgressEvent,
} from './_shared/synthesize-strategy-conversation';
import { COPY } from './_copy';
import type { StrategicPath } from '@/tools/schemas';
import type { DraftState, ProductState } from './OnboardingFlow';

const PLAN_TIMEOUT_MS = 180_000;

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
  launchChannel?: 'producthunt' | 'showhn' | 'both' | 'other' | null;
  usersBucket?: '<100' | '100-1k' | '1k-10k' | '10k+' | null;
}

/**
 * Emitted to OnboardingFlow on strategic completion. Tactical plan is always
 * null here — the tactical worker drafts it post-commit and Today streams
 * progress.
 */
interface PlanStrategicResult {
  path: StrategicPath;
  plan: null;
}

interface PlanEventStrategicDone {
  type: 'strategic_done';
  path: StrategicPath;
}

interface PlanEventError {
  type: 'error';
  error: string;
}

interface PlanEventToolProgress {
  type: 'tool_progress';
  phase: 'start' | 'done' | 'error';
  toolName: string;
  toolUseId: string;
  durationMs?: number;
  errorMessage?: string;
}

// Tolerant shape — backend may emit progress pings, keepalives, or events we
// don't care about. We switch on `type` and ignore anything else.
type PlanEvent =
  | PlanEventStrategicDone
  | PlanEventError
  | PlanEventToolProgress
  | { type: string; [key: string]: unknown };

interface StagePlanBuildingProps {
  draft: DraftState;
  /** Channels already connected from /api/channels. */
  connectedChannels: Array<'x' | 'reddit' | 'email'>;
  onGenerated: (response: PlanStrategicResult) => void;
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
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Append-only log of `tool_progress` SSE frames emitted by the
  // generating-strategy skill. Drives the synthetic chat hook; the
  // ordering here matches arrival order from the server, which is
  // the order the user should see in the subtask card.
  const [toolProgressEvents, setToolProgressEvents] = useState<
    readonly ToolProgressEvent[]
  >([]);
  // Wall-clock now, ticked once per second so the RUNNING pill keeps
  // counting up without the chat hook needing its own clock.
  const [now, setNow] = useState(() => Date.now());
  const startedAtRef = useRef<number>(Date.now());
  const responseRef = useRef<PlanStrategicResult | null>(null);
  const stateLabel = draft.productState ?? 'launching';

  useEffect(() => {
    if (done || error) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [done, error]);

  const conversationState = synthesizeStrategyConversation({
    toolProgressEvents,
    done,
    error,
    startedAt: startedAtRef.current,
    now,
  });

  // Auto-advance once the response has resolved. The previous
  // SixStepAnimator design waited for an internal animation timer
  // before calling `onComplete`; with the synthetic chat we have no
  // timer to wait on, so step forward immediately on `strategic_done`.
  useEffect(() => {
    if (!done) return;
    const r = responseRef.current;
    if (r) onGenerated(r);
  }, [done, onGenerated]);

  // Read draft + channels via refs so the effect below can be a one-shot
  // on mount. Using them as useEffect deps would rerun + abort the planner
  // fetch every time OnboardingFlow's `draft` object reference changes,
  // which happens on unrelated autosaves.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const channelsRef = useRef(connectedChannels);
  channelsRef.current = connectedChannels;

  // One-shot on mount. React Strict Mode in dev double-invokes mount
  // effects (mount → cleanup → mount); the `startedRef` latch stops the
  // second invoke from firing a duplicate planner call.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('timeout', 'AbortError')),
      PLAN_TIMEOUT_MS,
    );

    (async () => {
      try {
        const d = draftRef.current;
        const ch = channelsRef.current;
        const state = d.productState ?? 'launching';
        const body: PlanRequest = {
          product: {
            name: d.product?.name ?? '',
            description: d.product?.description ?? '',
            valueProp: d.product?.valueProp || null,
            keywords: d.product?.keywords ?? [],
            category: d.category,
            targetAudience: d.audience?.trim() || null,
          },
          channels: ch.length > 0 ? ch : ['reddit', 'x'],
          state,
          launchDate: state === 'launching' ? toIsoOrNull(d.launchDate) : null,
          launchedAt: state === 'launched' ? toIsoOrNull(d.launchedAt) : null,
          // launchChannel + usersBucket: backend Zod schema doesn't accept
          // these yet (audit #5). Sent anyway so the moment the schema is
          // extended they flow through with zero client-side churn. Zod
          // strips unknown keys by default so this is inert today.
          launchChannel:
            state === 'launching' ? d.launchChannel ?? null : null,
          usersBucket:
            state === 'launched' ? d.usersBucket ?? null : null,
        };

        const res = await fetch('/api/onboarding/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Errors are still JSON (route returns JSON on 4xx before switching
          // to the SSE stream for 200). Parse defensively.
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          throw new Error(errBody.detail || errBody.error || `${res.status}`);
        }
        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error('Plan stream returned no reader');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let resolved = false;
        while (!resolved) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const line = part
              .split('\n')
              .find((l) => l.startsWith('data: '));
            if (!line) continue;
            let parsed: PlanEvent;
            try {
              parsed = JSON.parse(line.slice(6)) as PlanEvent;
            } catch {
              continue;
            }
            if (parsed.type === 'error') {
              const ev = parsed as PlanEventError;
              throw new Error(ev.error || 'Plan generation failed');
            }
            if (parsed.type === 'tool_progress') {
              const ev = parsed as PlanEventToolProgress;
              setToolProgressEvents((prev) => [
                ...prev,
                {
                  toolName: ev.toolName,
                  phase: ev.phase,
                  toolUseId: ev.toolUseId,
                  durationMs: ev.durationMs,
                  errorMessage: ev.errorMessage,
                },
              ]);
              continue;
            }
            if (parsed.type === 'strategic_done') {
              const ev = parsed as PlanEventStrategicDone;
              responseRef.current = { path: ev.path, plan: null };
              setDone(true);
              resolved = true;
              // Keep the connection open so the server can finish flushing
              // other events without erroring, but stop consuming — the
              // reader will be cancelled in the finally block.
              break;
            }
            // Unknown event types are ignored on purpose (tactical_done,
            // keepalives, etc. — tactical lives on /today now).
          }
        }
        if (!resolved) {
          throw new Error('Plan stream ended without strategic_done');
        }
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
    };
  }, []);

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
          margin: '0 0 6px',
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
      <p
        style={{
          margin: '0 0 24px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 13,
          lineHeight: 1.4,
          letterSpacing: '-0.08px',
          color: 'var(--sf-fg-3)',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--sf-font-mono)',
            fontSize: 13,
            color: 'var(--sf-accent)',
            letterSpacing: '-0.08px',
          }}
        >
          {COPY.stage6.durationHint}
        </span>
        <span>{COPY.stage6.durationCaption}</span>
      </p>

      <SyntheticChatConversation state={conversationState} />

      {!error && !done && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <OnbButton variant="ghost" onClick={onCancel}>
            Cancel
          </OnbButton>
        </div>
      )}

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
