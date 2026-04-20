// SixStepAnimator — shared between Stage 2 (scanning) and Stage 6 (plan-building).
// Black card with a running agent header + 6 rows with pending/active/done states.
// Steps advance on ~850ms + up to 400ms random jitter; animation is purely
// decorative (caller drives the real backend call in parallel).
//
// Accessibility: rows live in a `role="status" aria-live="polite"` region so
// screen readers get the current active label without getting spammed by the
// per-step transitions.

'use client';

import { useEffect, useRef, useState } from 'react';
import { Check } from '../icons';
import { OnbMono } from './onb-mono';

export interface SixStepAnimatorStep {
  readonly id: string;
  readonly label: string;
  readonly target: string;
}

interface SixStepAnimatorProps {
  steps: readonly SixStepAnimatorStep[];
  /** Mono uppercase label in the header (e.g. "Scout · Running"). */
  agentName: string;
  cancelLabel: string;
  onCancel?: () => void;
  /**
   * When the caller's real backend call resolves, set `realCallComplete=true`.
   * The animator will either keep pulsing the last step (if animation runs
   * ahead of the network) or immediately finish the remaining steps (if the
   * network beat the animation) before calling `onComplete`.
   */
  realCallComplete: boolean;
  /** Optional real-call error — switches the header dot to red + stops animation. */
  realCallError?: string | null;
  /** Fires once after both animation + real call are done. */
  onComplete: () => void;
  /** Show elapsed + cost estimate in the header. */
  showCost?: boolean;
}

const STEP_DURATION_MS = 850;
const STEP_JITTER_MS = 400;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function SixStepAnimator({
  steps,
  agentName,
  cancelLabel,
  onCancel,
  realCallComplete,
  realCallError,
  onComplete,
  showCost = true,
}: SixStepAnimatorProps) {
  const [active, setActive] = useState(0);
  const [elapsed, setElapsed] = useState(0); // in 100ms ticks
  const [cost, setCost] = useState(0);
  const completedRef = useRef(false);

  // Step advancer — clamps at steps.length (never runs past the last row).
  useEffect(() => {
    if (realCallError) return;
    if (active >= steps.length) return;
    const reducedMotion = prefersReducedMotion();
    const duration = reducedMotion
      ? 50
      : STEP_DURATION_MS + Math.random() * STEP_JITTER_MS;
    const t = setTimeout(() => {
      setActive((a) => a + 1);
      setCost((c) => c + 0.003 + Math.random() * 0.01);
    }, duration);
    return () => clearTimeout(t);
  }, [active, steps.length, realCallError]);

  // Elapsed timer — ticks every 100ms for the header cost/time display.
  useEffect(() => {
    if (realCallError) return;
    const i = setInterval(() => setElapsed((e) => e + 1), 100);
    return () => clearInterval(i);
  }, [realCallError]);

  // Completion gate — both animation AND real call must finish.
  useEffect(() => {
    if (completedRef.current) return;
    if (realCallError) return;
    const animDone = active >= steps.length;
    if (animDone && realCallComplete) {
      completedRef.current = true;
      const t = setTimeout(onComplete, 400);
      return () => clearTimeout(t);
    }
  }, [active, realCallComplete, steps.length, onComplete, realCallError]);

  const lastStepIndex = steps.length - 1;
  const activeForRender =
    realCallComplete && active >= steps.length ? steps.length : active;

  return (
    <div
      style={{
        background: 'var(--sf-bg-dark)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: 'var(--sf-shadow-card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: realCallError ? 'var(--sf-error)' : 'var(--sf-success)',
              animation: realCallError
                ? 'none'
                : 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
            }}
          />
          <OnbMono color="var(--sf-fg-on-dark-2)">
            {agentName} · {realCallError ? 'Error' : 'Running'}
          </OnbMono>
        </div>
        {showCost && (
          <OnbMono color="var(--sf-fg-on-dark-4)">
            ${cost.toFixed(3)} / {(elapsed / 10).toFixed(1)}s
          </OnbMono>
        )}
      </div>

      <div
        role="status"
        aria-live="polite"
        style={{ padding: '8px 0', maxHeight: 360, overflowY: 'auto' }}
      >
        {steps.map((s, i) => {
          const isDone =
            i < activeForRender || (realCallComplete && i === lastStepIndex && active > lastStepIndex);
          const isActive =
            !realCallError && i === active && active < steps.length;
          const isHoldingLast =
            !realCallError &&
            !realCallComplete &&
            i === lastStepIndex &&
            active >= steps.length;
          const isPending = i > active && !isHoldingLast;
          return (
            <div
              key={s.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 16px',
                opacity: isPending ? 0.35 : 1,
                transition: 'opacity 300ms cubic-bezier(0.16,1,0.3,1)',
              }}
            >
              <InnerDot
                done={i < active}
                active={isActive || isHoldingLast}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    letterSpacing: '-0.16px',
                    color:
                      i < active
                        ? 'var(--sf-fg-on-dark-2)'
                        : 'var(--sf-fg-on-dark-1)',
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {s.label}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--sf-font-mono)',
                    fontSize: 11,
                    letterSpacing: '-0.08px',
                    color: 'var(--sf-fg-on-dark-4)',
                    marginTop: 2,
                  }}
                >
                  {s.target}
                </div>
              </div>
              {i < active && (
                <OnbMono color="var(--sf-success)" style={{ fontSize: 10 }}>
                  OK
                </OnbMono>
              )}
            </div>
          );
          void isDone;
        })}
      </div>

      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <OnbMono color="var(--sf-fg-on-dark-4)">
          {Math.min(active, steps.length)} / {steps.length} complete
        </OnbMono>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--sf-fg-on-dark-3)',
              fontSize: 12,
              fontFamily: 'var(--sf-font-mono)',
              letterSpacing: '-0.08px',
              textTransform: 'uppercase',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function InnerDot({ done, active }: { done: boolean; active: boolean }) {
  if (done) {
    return (
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'var(--sf-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <Check size={11} />
      </span>
    );
  }
  if (active) {
    return (
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          border: '1.5px solid var(--sf-accent)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--sf-accent)',
            animation: 'sf-pulse 1.2s cubic-bezier(0.4,0,0.6,1) infinite',
          }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: '1.5px solid rgba(255,255,255,0.20)',
        flexShrink: 0,
      }}
    />
  );
}
