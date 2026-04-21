// TacticalProgressCard — live progress widget pinned above the Today feed
// while the post-commit tactical-generate worker drafts this week's items
// and (optionally) platform calibration is still running.
//
// Contract (locked with backend-engineer-sse):
//   - Mount-time snapshot: GET /api/today/progress (REST, JSON)
//   - Live updates:        /api/events?channel=agents via useSSEChannel
//                          (tactical_generate_{started,completed,failed}
//                           and calibration_{progress,complete})
//
// Visibility gate: shows when `?from=onboarding` is in URL (within the same
// 24h TTL as the welcome ribbon) OR whenever the snapshot reports in-flight
// tactical / calibration work.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { OnbMono } from '@/components/onboarding/_shared/onb-mono';
import { PLATFORMS } from '@/lib/platform-config';
import { WELCOME_HERO_SEEN_KEY } from '@/components/today/today-welcome-ribbon';
import { useSSEChannel } from '@/hooks/use-sse-channel';

/* ─── Backend contract ───────────────────────────────────────────────── */

type TacticalStatus = 'pending' | 'running' | 'completed' | 'failed';
type CalibrationStatus = 'pending' | 'running' | 'completed' | 'failed';

interface TacticalSnapshot {
  status: TacticalStatus;
  itemCount: number;
  expectedCount: number | null;
  error: string | null;
  planId: string | null;
}

interface PlatformCalibration {
  platform: string;
  status: CalibrationStatus;
  precision: number | null;
  round: number;
}

interface ProgressSnapshot {
  tactical: TacticalSnapshot;
  calibration: { platforms: PlatformCalibration[] };
}

// Live events published on `shipflare:events:{userId}:agents` (see
// tactical-generate processor + calibrate-discovery worker on the backend).
interface TacticalGenerateStarted {
  type: 'tactical_generate_started';
  planId: string;
  traceId: string;
}
interface TacticalGenerateCompleted {
  type: 'tactical_generate_completed';
  planId: string;
  itemCount: number;
  traceId: string;
}
interface TacticalGenerateFailed {
  type: 'tactical_generate_failed';
  planId: string;
  error: string;
  traceId: string;
}
interface CalibrationProgress {
  type: 'calibration_progress';
  platform: string;
  round: number;
  maxRounds: number;
}
interface CalibrationComplete {
  type: 'calibration_complete';
  productId: string;
}

type LiveEvent =
  | TacticalGenerateStarted
  | TacticalGenerateCompleted
  | TacticalGenerateFailed
  | CalibrationProgress
  | CalibrationComplete
  | { type: string; [key: string]: unknown };

/* ─── View state ─────────────────────────────────────────────────────── */

/** Calibration isn't fanned out by platform in the `_complete` event, so the
 * client can't directly mark a single platform done from a live event. We
 * use the max known round per platform + final-step detection to collapse.
 */
interface CalibrationView {
  platform: string;
  status: CalibrationStatus;
  precision: number | null;
  round: number;
  maxRounds: number | null;
}

interface ViewState {
  tactical: TacticalSnapshot;
  calibration: Record<string, CalibrationView>;
  /** True once the mount-time snapshot fetch has resolved (success or failure). */
  snapshotLoaded: boolean;
}

const INITIAL_VIEW: ViewState = {
  tactical: {
    status: 'pending',
    itemCount: 0,
    expectedCount: null,
    error: null,
    planId: null,
  },
  calibration: {},
  snapshotLoaded: false,
};

function seedFromSnapshot(state: ViewState, snap: ProgressSnapshot): ViewState {
  const calibration: Record<string, CalibrationView> = {};
  for (const row of snap.calibration.platforms) {
    calibration[row.platform] = {
      platform: row.platform,
      status: row.status,
      precision: row.precision,
      round: row.round,
      maxRounds: null,
    };
  }
  return { tactical: snap.tactical, calibration, snapshotLoaded: true };
}

function reduceLive(state: ViewState, event: LiveEvent): ViewState {
  switch (event.type) {
    case 'tactical_generate_started': {
      const ev = event as TacticalGenerateStarted;
      return {
        ...state,
        tactical: {
          status: 'running',
          itemCount: 0,
          expectedCount: state.tactical.expectedCount,
          error: null,
          planId: ev.planId,
        },
      };
    }
    case 'tactical_generate_completed': {
      const ev = event as TacticalGenerateCompleted;
      return {
        ...state,
        tactical: {
          status: 'completed',
          itemCount: ev.itemCount,
          expectedCount: state.tactical.expectedCount,
          error: null,
          planId: ev.planId,
        },
      };
    }
    case 'tactical_generate_failed': {
      const ev = event as TacticalGenerateFailed;
      return {
        ...state,
        tactical: {
          ...state.tactical,
          status: 'failed',
          error: ev.error,
          planId: ev.planId,
        },
      };
    }
    case 'calibration_progress': {
      const ev = event as CalibrationProgress;
      const prev = state.calibration[ev.platform];
      return {
        ...state,
        calibration: {
          ...state.calibration,
          [ev.platform]: {
            platform: ev.platform,
            status: 'running',
            precision: prev?.precision ?? null,
            round: ev.round,
            maxRounds: ev.maxRounds,
          },
        },
      };
    }
    case 'calibration_complete': {
      // Event is keyed by productId, not platform. Mark every running
      // platform as completed — calibration_complete fires once per
      // product-level pass.
      const next: Record<string, CalibrationView> = {};
      for (const [k, v] of Object.entries(state.calibration)) {
        next[k] = v.status === 'running' ? { ...v, status: 'completed' } : v;
      }
      return { ...state, calibration: next };
    }
    default:
      return state;
  }
}

/* ─── Visibility gate ────────────────────────────────────────────────── */

const RIBBON_TTL_MS = 24 * 60 * 60 * 1000;
const SUCCESS_GRACE_MS = 5_000;

function shouldRemainVisible(
  fromOnboarding: boolean,
  state: ViewState,
  tacticalCollapsedAt: number | null,
): boolean {
  const t = state.tactical.status;
  if (t === 'running' || t === 'failed') return true;
  if (t === 'pending' && fromOnboarding) return true;
  if (t === 'completed') {
    if (tacticalCollapsedAt === null) return true;
    if (Date.now() - tacticalCollapsedAt < SUCCESS_GRACE_MS) return true;
  }
  for (const row of Object.values(state.calibration)) {
    if (row.status === 'running' || row.status === 'failed') return true;
  }
  return false;
}

/* ─── Component ──────────────────────────────────────────────────────── */

export function TacticalProgressCard() {
  const searchParams = useSearchParams();
  const fromOnboardingQuery = searchParams?.get('from') === 'onboarding';
  const [fromOnboardingSession, setFromOnboardingSession] = useState(false);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [dismissed, setDismissed] = useState(false);
  const tacticalCollapsedAtRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  // Hero-seen timestamp piggybacks on the welcome ribbon's 24h window.
  useEffect(() => {
    if (fromOnboardingQuery) {
      setFromOnboardingSession(true);
      return;
    }
    try {
      const seen = window.localStorage.getItem(WELCOME_HERO_SEEN_KEY);
      if (!seen) return;
      const seenAt = Number(seen);
      if (!Number.isFinite(seenAt)) return;
      if (Date.now() - seenAt < RIBBON_TTL_MS) {
        setFromOnboardingSession(true);
      }
    } catch {
      /* localStorage unavailable */
    }
  }, [fromOnboardingQuery]);

  // Mount-time snapshot. Uses an AbortController so the dev Strict-Mode
  // double-mount doesn't produce a duplicate in-flight request.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/today/progress', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`snapshot ${res.status}`);
        const snap = (await res.json()) as ProgressSnapshot;
        setView((prev) => seedFromSnapshot(prev, snap));
      } catch {
        // Mark loaded even on failure so the visibility gate can still
        // decide (fromOnboarding-only case). Live events will populate
        // the rest.
        setView((prev) => ({ ...prev, snapshotLoaded: true }));
      }
    })();
    return () => controller.abort();
  }, []);

  // Live events. `useSSEChannel` already filters heartbeat/connected frames.
  const handleLiveEvent = useCallback((data: unknown) => {
    if (
      !data ||
      typeof data !== 'object' ||
      !('type' in data) ||
      typeof (data as { type: unknown }).type !== 'string'
    ) {
      return;
    }
    setView((prev) => reduceLive(prev, data as LiveEvent));
  }, []);
  useSSEChannel('agents', handleLiveEvent);

  // When tactical flips to completed, stamp the collapse wall-clock once and
  // schedule a re-render at the end of the grace window so visibility
  // re-evaluates.
  useEffect(() => {
    if (
      view.tactical.status === 'completed' &&
      tacticalCollapsedAtRef.current === null
    ) {
      tacticalCollapsedAtRef.current = Date.now();
      const t = window.setTimeout(
        () => forceTick((n) => n + 1),
        SUCCESS_GRACE_MS + 100,
      );
      return () => window.clearTimeout(t);
    }
    if (view.tactical.status !== 'completed') {
      tacticalCollapsedAtRef.current = null;
    }
  }, [view.tactical.status]);

  const fromOnboarding = fromOnboardingSession || fromOnboardingQuery;
  const visible = useMemo(
    () =>
      !dismissed &&
      view.snapshotLoaded &&
      shouldRemainVisible(fromOnboarding, view, tacticalCollapsedAtRef.current),
    [dismissed, fromOnboarding, view],
  );

  if (!visible) return null;

  const calibrationRows = Object.values(view.calibration).filter(
    (r) => r.status === 'running' || r.status === 'failed',
  );
  const showTactical =
    view.tactical.status === 'running' ||
    view.tactical.status === 'failed' ||
    view.tactical.status === 'completed' ||
    (view.tactical.status === 'pending' && fromOnboarding);

  return (
    <section
      aria-live="polite"
      style={{
        position: 'relative',
        margin: '0 clamp(16px, 3vw, 32px) 16px',
        background: 'var(--sf-bg-secondary)',
        borderRadius: 'var(--sf-radius-xl, 14px)',
        boxShadow: 'var(--sf-shadow-card)',
        overflow: 'hidden',
      }}
    >
      {showTactical && <TacticalSection tactical={view.tactical} />}
      {calibrationRows.length > 0 && (
        <CalibrationSection
          rows={calibrationRows}
          hasTacticalDivider={showTactical}
        />
      )}
      {view.tactical.status === 'completed' && calibrationRows.length === 0 && (
        <DismissHandle onDismiss={() => setDismissed(true)} />
      )}
    </section>
  );
}

/* ─── Tactical section ───────────────────────────────────────────────── */

function TacticalSection({ tactical }: { tactical: TacticalSnapshot }) {
  const { status, itemCount, expectedCount, error } = tactical;
  const isFailed = status === 'failed';
  const isDone = status === 'completed';
  const headline = isFailed
    ? 'Drafting stalled'
    : isDone
      ? 'This week is drafted'
      : "Drafting this week's plan…";
  const subline = isFailed
    ? error || 'Drafting hit an error. Retry when you have a sec.'
    : isDone
      ? 'Items are now in your inbox below.'
      : 'Each item appears below as it lands.';
  // Backend doesn't expose expectedCount today (always null); fall back to
  // a friendly "—" in the count but still drive the bar to 100% on completed
  // so the card doesn't finish stuck at 0.
  const countLabel =
    expectedCount && expectedCount > 0
      ? `${itemCount} / ${expectedCount} items`
      : isDone
        ? `${itemCount} items`
        : itemCount > 0
          ? `${itemCount} items so far`
          : 'Queued';
  const pct = isDone
    ? 100
    : expectedCount && expectedCount > 0
      ? Math.min(100, Math.round((itemCount / expectedCount) * 100))
      : 0;

  return (
    <div style={{ padding: '18px 20px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <OnbMono color={isFailed ? 'var(--sf-error-ink)' : 'var(--sf-accent)'}>
          {isFailed ? 'Tactical · Error' : isDone ? 'Tactical · Ready' : 'Tactical'}
        </OnbMono>
        {!isFailed && !isDone && <PulsingDot />}
        <span style={{ flex: 1 }} />
        <OnbMono color="var(--sf-fg-4)">{countLabel}</OnbMono>
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          letterSpacing: '-0.2px',
          color: 'var(--sf-fg-1)',
          marginBottom: 4,
        }}
      >
        {headline}
      </div>
      <div
        style={{
          fontSize: 13,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-3)',
          marginBottom: 14,
          lineHeight: 1.45,
        }}
      >
        {subline}
      </div>
      <ProgressBar
        pct={pct}
        intent={isFailed ? 'error' : isDone ? 'success' : 'running'}
        indeterminate={!isFailed && !isDone && pct === 0}
      />
      {isFailed && (
        <div style={{ marginTop: 12 }}>
          <RetryButton />
        </div>
      )}
    </div>
  );
}

function ProgressBar({
  pct,
  intent,
  indeterminate,
}: {
  pct: number;
  intent: 'running' | 'success' | 'error';
  indeterminate: boolean;
}) {
  const fill =
    intent === 'error'
      ? 'var(--sf-error-ink)'
      : intent === 'success'
        ? 'var(--sf-success)'
        : 'var(--sf-accent)';
  if (indeterminate) {
    // We don't know `expectedCount` up front (backend returns null), so
    // before any items land we show a seeking shimmer instead of a 0% bar.
    return (
      <div
        style={{
          height: 4,
          borderRadius: 999,
          background: 'rgba(0,0,0,0.06)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: '40%',
            background: fill,
            borderRadius: 999,
            animation: 'sfTacticalSeek 1400ms ease-in-out infinite',
          }}
        />
        <style>{`
          @keyframes sfTacticalSeek {
            0%   { transform: translateX(-100%); }
            100% { transform: translateX(250%); }
          }
        `}</style>
      </div>
    );
  }
  return (
    <div
      style={{
        height: 4,
        borderRadius: 999,
        background: 'rgba(0,0,0,0.06)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: fill,
          borderRadius: 999,
          transition: 'width 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />
    </div>
  );
}

function PulsingDot() {
  return (
    <>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--sf-accent)',
          animation: 'sfTacticalPulse 1400ms ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes sfTacticalPulse {
          0%, 100% { opacity: 0.32; transform: scale(0.9); }
          50%      { opacity: 1;    transform: scale(1.1); }
        }
      `}</style>
    </>
  );
}

/* ─── Calibration section ────────────────────────────────────────────── */

function CalibrationSection({
  rows,
  hasTacticalDivider,
}: {
  rows: CalibrationView[];
  hasTacticalDivider: boolean;
}) {
  return (
    <div
      style={{
        padding: '16px 20px',
        borderTop: hasTacticalDivider ? '1px solid rgba(0,0,0,0.06)' : undefined,
      }}
    >
      <OnbMono style={{ marginBottom: 12, display: 'inline-block' }}>
        Calibration
      </OnbMono>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {rows.map((row) => (
          <CalibrationRowView key={row.platform} row={row} />
        ))}
      </div>
    </div>
  );
}

function CalibrationRowView({ row }: { row: CalibrationView }) {
  const cfg = PLATFORMS[row.platform];
  const displayName = cfg?.displayName ?? row.platform;
  const isFailed = row.status === 'failed';
  const precisionText =
    row.precision === null || row.precision === undefined
      ? '—'
      : row.precision.toFixed(2);
  const roundText = row.maxRounds
    ? `Round ${row.round}/${row.maxRounds}`
    : `Round ${row.round}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'rgba(0,0,0,0.03)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: isFailed ? 'var(--sf-error-ink)' : 'var(--sf-accent)',
          animation: isFailed
            ? undefined
            : 'sfTacticalPulse 1400ms ease-in-out infinite',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '-0.16px',
          color: 'var(--sf-fg-1)',
          width: 80,
          flexShrink: 0,
        }}
      >
        {displayName}
      </span>
      <OnbMono color="var(--sf-fg-3)">
        {isFailed ? 'Error' : 'Calibrating'}
      </OnbMono>
      <span style={{ flex: 1 }} />
      <OnbMono color="var(--sf-fg-4)">{roundText}</OnbMono>
      <OnbMono color="var(--sf-fg-4)">Precision {precisionText}</OnbMono>
    </div>
  );
}

/* ─── Retry + dismiss ────────────────────────────────────────────────── */

function RetryButton() {
  const [submitting, setSubmitting] = useState(false);
  const onClick = async () => {
    setSubmitting(true);
    try {
      // Matches the existing /api/plan/replan endpoint that runs the full
      // tactical pass (supersede + insert) for the current week.
      await fetch('/api/plan/replan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: 'manual' }),
      });
      // The SSE stream will emit tactical_generate_started → running, then
      // completed or failed when the worker finishes.
    } catch {
      // The error strip stays visible; the user can retry again.
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={submitting}
      style={{
        height: 30,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid rgba(0,0,0,0.08)',
        background: 'var(--sf-bg-primary, #fff)',
        color: 'var(--sf-fg-1)',
        cursor: submitting ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: '-0.16px',
      }}
    >
      {submitting ? 'Retrying…' : 'Retry drafting'}
    </button>
  );
}

function DismissHandle({ onDismiss }: { onDismiss: () => void }) {
  // Rendered after the 5s success grace so the user can hide the card early
  // if they prefer. Keeps a11y affordance even though the card auto-hides.
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Hide planning progress"
      style={{
        position: 'absolute',
        clip: 'rect(0 0 0 0)',
        clipPath: 'inset(50%)',
        height: 1,
        width: 1,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      Hide
    </button>
  );
}
