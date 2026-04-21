// TacticalProgressCard — live progress widget pinned above the Today feed
// while the post-commit tactical-generate worker drafts this week's items
// and (optionally) platform calibration is still running.
//
// Subscribes to `/api/today/progress` (SSE) and folds discrete events into
// a single view model. Renders two stacked sections — tactical draft
// progress and per-platform calibration — which auto-collapse when their
// respective work finishes.
//
// Visibility gate: shows when `?from=onboarding` is in URL (within the same
// 24h TTL as the welcome ribbon) OR whenever a live snapshot reports
// in-flight tactical / calibration work.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { OnbMono } from '@/components/onboarding/_shared/onb-mono';
import { PLATFORMS } from '@/lib/platform-config';
import { WELCOME_HERO_SEEN_KEY } from '@/components/today/today-welcome-ribbon';

/* ─── Event shape — mirrors /api/today/progress SSE contract ─────────── */

type TacticalStatus = 'pending' | 'running' | 'done' | 'error';

interface TacticalSnapshot {
  status: TacticalStatus;
  drafted: number;
  expected: number;
  error?: string | null;
}

type CalibrationStatus = 'pending' | 'running' | 'done' | 'error';

interface CalibrationRow {
  platform: string;
  status: CalibrationStatus;
  round: number;
  maxRounds: number;
  precision: number | null;
}

interface ProgressEventSnapshot {
  type: 'snapshot';
  tactical: TacticalSnapshot;
  calibration: CalibrationRow[];
}

interface ProgressEventTacticalItem {
  type: 'tactical_item_drafted';
  count: number;
  expected: number;
}

interface ProgressEventTacticalDone {
  type: 'tactical_done';
}

interface ProgressEventTacticalError {
  type: 'tactical_error';
  error: string;
}

interface ProgressEventCalibrationUpdate {
  type: 'calibration_update';
  platform: string;
  round: number;
  maxRounds: number;
  precision: number | null;
}

interface ProgressEventCalibrationDone {
  type: 'calibration_done';
  platform: string;
}

type ProgressEvent =
  | ProgressEventSnapshot
  | ProgressEventTacticalItem
  | ProgressEventTacticalDone
  | ProgressEventTacticalError
  | ProgressEventCalibrationUpdate
  | ProgressEventCalibrationDone
  | { type: string; [key: string]: unknown };

/* ─── View state ─────────────────────────────────────────────────────── */

interface ViewState {
  tactical: TacticalSnapshot;
  /** Keyed by platform id so repeat `calibration_update` events merge cleanly. */
  calibration: Record<string, CalibrationRow>;
}

const INITIAL_VIEW: ViewState = {
  tactical: { status: 'pending', drafted: 0, expected: 0 },
  calibration: {},
};

function reduce(state: ViewState, event: ProgressEvent): ViewState {
  switch (event.type) {
    case 'snapshot': {
      const ev = event as ProgressEventSnapshot;
      const calibration: Record<string, CalibrationRow> = {};
      for (const row of ev.calibration) {
        calibration[row.platform] = row;
      }
      return { tactical: ev.tactical, calibration };
    }
    case 'tactical_item_drafted': {
      const ev = event as ProgressEventTacticalItem;
      return {
        ...state,
        tactical: {
          ...state.tactical,
          status: 'running',
          drafted: ev.count,
          expected: ev.expected,
        },
      };
    }
    case 'tactical_done': {
      return {
        ...state,
        tactical: {
          ...state.tactical,
          status: 'done',
          // Collapse to expected once done so the final count reads cleanly
          // if we missed an intermediate `tactical_item_drafted` event.
          drafted: Math.max(state.tactical.drafted, state.tactical.expected),
        },
      };
    }
    case 'tactical_error': {
      const ev = event as ProgressEventTacticalError;
      return {
        ...state,
        tactical: { ...state.tactical, status: 'error', error: ev.error },
      };
    }
    case 'calibration_update': {
      const ev = event as ProgressEventCalibrationUpdate;
      return {
        ...state,
        calibration: {
          ...state.calibration,
          [ev.platform]: {
            platform: ev.platform,
            status: 'running',
            round: ev.round,
            maxRounds: ev.maxRounds,
            precision: ev.precision,
          },
        },
      };
    }
    case 'calibration_done': {
      const ev = event as ProgressEventCalibrationDone;
      const existing = state.calibration[ev.platform];
      if (!existing) return state;
      return {
        ...state,
        calibration: {
          ...state.calibration,
          [ev.platform]: { ...existing, status: 'done' },
        },
      };
    }
    default:
      return state;
  }
}

/* ─── Visibility gate ────────────────────────────────────────────────── */

const RIBBON_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Show when:
 *  - `?from=onboarding` was in the URL, OR the onboarding hero-seen
 *    timestamp is within the 24h TTL, OR
 *  - there is active tactical / calibration work in the current snapshot.
 */
function shouldRemainVisible(
  fromOnboarding: boolean,
  state: ViewState,
  tacticalCollapsedAt: number | null,
): boolean {
  if (state.tactical.status === 'running' || state.tactical.status === 'error') {
    return true;
  }
  if (state.tactical.status === 'pending' && fromOnboarding) return true;
  // After tactical completes we keep the card around for 5s as a success chip,
  // then hide.
  if (state.tactical.status === 'done') {
    if (tacticalCollapsedAt === null) return true;
    if (Date.now() - tacticalCollapsedAt < 5_000) return true;
  }
  // Show if any platform is still calibrating.
  for (const row of Object.values(state.calibration)) {
    if (row.status === 'running' || row.status === 'error') return true;
  }
  return false;
}

/* ─── Component ──────────────────────────────────────────────────────── */

interface TacticalProgressCardProps {
  /**
   * When null, the component mounts its own SSE subscription. A parent can
   * inject its own event stream (e.g. for tests) by passing a pre-built
   * readable here.
   */
  endpoint?: string;
}

export function TacticalProgressCard({
  endpoint = '/api/today/progress',
}: TacticalProgressCardProps) {
  const searchParams = useSearchParams();
  const fromOnboardingQuery = searchParams?.get('from') === 'onboarding';
  const [fromOnboardingSession, setFromOnboardingSession] = useState(false);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [dismissed, setDismissed] = useState(false);
  const tacticalCollapsedAtRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  // Hero-seen timestamp piggybacks on the welcome ribbon's 24h window so we
  // stay in-sync with that existing localStorage key.
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
      /* localStorage unavailable — fall back to query-string only */
    }
  }, [fromOnboardingQuery]);

  // Mark the collapse wall-clock the first time we see `done`, so the 5s
  // grace window is deterministic.
  useEffect(() => {
    if (view.tactical.status === 'done' && tacticalCollapsedAtRef.current === null) {
      tacticalCollapsedAtRef.current = Date.now();
      // Re-render after 5s so the visibility gate re-evaluates.
      const t = window.setTimeout(() => forceTick((n) => n + 1), 5_100);
      return () => window.clearTimeout(t);
    }
  }, [view.tactical.status]);

  // SSE subscription. `endpoint` is stable but we guard with an AbortController
  // so dev Strict-Mode double-mount doesn't leak a reader.
  useEffect(() => {
    const controller = new AbortController();
    void consumeStream(endpoint, controller.signal, (event) => {
      setView((prev) => reduce(prev, event));
    });
    return () => controller.abort();
  }, [endpoint]);

  const visible = useMemo(
    () =>
      !dismissed &&
      (fromOnboardingSession || fromOnboardingQuery
        ? shouldRemainVisible(true, view, tacticalCollapsedAtRef.current)
        : shouldRemainVisible(false, view, tacticalCollapsedAtRef.current)),
    [dismissed, fromOnboardingSession, fromOnboardingQuery, view],
  );

  if (!visible) return null;

  const calibrationRows = Object.values(view.calibration).filter(
    (r) => r.status !== 'done',
  );
  const showTactical =
    view.tactical.status === 'running' ||
    view.tactical.status === 'error' ||
    (view.tactical.status === 'pending' && fromOnboardingSession) ||
    view.tactical.status === 'done';

  return (
    <section
      aria-live="polite"
      style={{
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
      {view.tactical.status === 'done' && calibrationRows.length === 0 && (
        <DismissHandle onDismiss={() => setDismissed(true)} />
      )}
    </section>
  );
}

/* ─── SSE stream consumer ────────────────────────────────────────────── */

async function consumeStream(
  endpoint: string,
  signal: AbortSignal,
  onEvent: (event: ProgressEvent) => void,
): Promise<void> {
  try {
    const res = await fetch(endpoint, {
      signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const parsed = JSON.parse(line.slice(6)) as ProgressEvent;
          onEvent(parsed);
        } catch {
          // Malformed frame — skip. SSE servers can flush partial writes
          // that we'll catch on the next iteration.
        }
      }
    }
  } catch {
    // Network hiccups are fine — the user can refresh. We don't want a
    // failed stream to explode the whole /today view.
  }
}

/* ─── Tactical section ───────────────────────────────────────────────── */

function TacticalSection({ tactical }: { tactical: TacticalSnapshot }) {
  const { status, drafted, expected, error } = tactical;
  const isError = status === 'error';
  const isDone = status === 'done';
  const headline = isError
    ? 'Drafting stalled'
    : isDone
      ? 'This week is drafted'
      : "Drafting this week's plan…";
  const subline = isError
    ? error || 'Drafting hit an error. Retry when you have a sec.'
    : isDone
      ? 'Items are now in your inbox below.'
      : 'Each item appears below as it lands.';
  // Clamp pct so `drafted > expected` (edge case with server clock skew)
  // still renders a sane bar.
  const pct =
    expected > 0 ? Math.min(100, Math.round((drafted / expected) * 100)) : 0;

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
        <OnbMono color={isError ? 'var(--sf-error-ink)' : 'var(--sf-accent)'}>
          {isError ? 'Tactical · Error' : isDone ? 'Tactical · Ready' : 'Tactical'}
        </OnbMono>
        {!isError && !isDone && <PulsingDot />}
        <span style={{ flex: 1 }} />
        <OnbMono color="var(--sf-fg-4)">
          {drafted} / {expected || '—'} items
        </OnbMono>
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
      <ProgressBar pct={pct} intent={isError ? 'error' : isDone ? 'success' : 'running'} />
      {isError && (
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
}: {
  pct: number;
  intent: 'running' | 'success' | 'error';
}) {
  const fill =
    intent === 'error'
      ? 'var(--sf-error-ink)'
      : intent === 'success'
        ? 'var(--sf-success)'
        : 'var(--sf-accent)';
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
  rows: CalibrationRow[];
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

function CalibrationRowView({ row }: { row: CalibrationRow }) {
  const cfg = PLATFORMS[row.platform];
  const displayName = cfg?.displayName ?? row.platform;
  const isError = row.status === 'error';
  const precisionText =
    row.precision === null || row.precision === undefined
      ? '—'
      : row.precision.toFixed(2);
  const roundText = `Round ${row.round}/${row.maxRounds}`;

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
          background: isError ? 'var(--sf-error-ink)' : 'var(--sf-accent)',
          animation: isError
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
        {isError ? 'Error' : 'Calibrating'}
      </OnbMono>
      <span style={{ flex: 1 }} />
      <OnbMono color="var(--sf-fg-4)">{roundText}</OnbMono>
      <OnbMono color="var(--sf-fg-4)">Precision {precisionText}</OnbMono>
    </div>
  );
}

/* ─── Secondary UI ───────────────────────────────────────────────────── */

function RetryButton() {
  const [submitting, setSubmitting] = useState(false);
  const onClick = async () => {
    setSubmitting(true);
    try {
      await fetch('/api/plan/replan', { method: 'POST' });
      // The SSE stream will pick up a fresh `snapshot` from the server,
      // flipping the card back into running state.
    } catch {
      // Intentional no-op — the error strip stays visible and the user can
      // try again. Dedicated toasting lives in the page orchestrator.
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
