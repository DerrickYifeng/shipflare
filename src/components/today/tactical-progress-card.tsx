// TacticalProgressCard — live progress widget pinned above the Today feed
// while the post-commit team-run drafts this week's plan_items and
// (optionally) calibration / discovery are still running.
//
// Contract:
//   - Mount-time snapshot: GET /api/today/progress (REST, JSON)
//   - Tactical live feed:  /api/team/events?teamId=…&runId=… via
//                          useTeamEvents. We count `add_plan_item` tool_calls
//                          for itemCount, watch for a coordinator `completion`
//                          message, and surface `error` messages.
//   - Generic tool_progress feed: /api/events?channel=agents via useSSEChannel.
//                          Routes `tool_progress` events by toolName:
//                          · calibrate_search_strategy → CalibrationSection
//                          · run_discovery_scan        → DiscoverySection
//                          · anything else             → ActivityTicker
//
// Visibility gate: shows when `?from=onboarding` is in URL (within the same
// 24h TTL as the welcome ribbon) OR whenever the snapshot reports in-flight
// tactical / calibration / discovery work, or the ticker has fired recently.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { OnbMono } from '@/components/onboarding/_shared/onb-mono';
import { PLATFORMS } from '@/lib/platform-config';
import { WELCOME_HERO_SEEN_KEY } from '@/components/today/today-welcome-ribbon';
import { useSSEChannel } from '@/hooks/use-sse-channel';
import { useTeamEvents, type TeamActivityMessage } from '@/hooks/use-team-events';
import {
  reduceToolProgress,
  INITIAL_TOOL_PROGRESS,
  type ToolProgressEventInput,
  type ToolProgressViewState,
  type CalibrationRow,
  type DiscoveryRow,
  type TickerRow,
} from './tactical-progress-card-reducer';

// Re-export so the reducer test can import from '../tactical-progress-card'
export {
  reduceToolProgress,
  type ToolProgressEventInput,
  type ToolProgressViewState,
  type CalibrationRow,
  type DiscoveryRow,
  type TickerRow,
} from './tactical-progress-card-reducer';

/* ─── Backend contract ───────────────────────────────────────────────── */

type TacticalStatus = 'pending' | 'running' | 'completed' | 'failed';

interface TacticalSnapshot {
  status: TacticalStatus;
  itemCount: number;
  expectedCount: number | null;
  error: string | null;
  planId: string | null;
}

interface TeamRunRef {
  teamId: string;
  runId: string;
}

interface ProgressSnapshot {
  tactical: TacticalSnapshot;
  teamRun: TeamRunRef | null;
  calibration: { platforms: { platform: string; status: string; precision: number | null; round: number }[] };
}

/* ─── View state ─────────────────────────────────────────────────────── */

interface ViewState {
  tactical: TacticalSnapshot;
  teamRun: TeamRunRef | null;
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
  teamRun: null,
  snapshotLoaded: false,
};

function seedFromSnapshot(state: ViewState, snap: ProgressSnapshot): ViewState {
  return {
    ...state,
    tactical: snap.tactical,
    teamRun: snap.teamRun,
    snapshotLoaded: true,
  };
}

/**
 * Fold the team_messages stream into a tactical snapshot. Each
 * `add_plan_item` tool_call counts toward itemCount; a `completion` message
 * marks the run done; an `error` message marks failure. Pure — the caller
 * wires it into React state.
 */
export function deriveTacticalFromMessages(
  messages: readonly TeamActivityMessage[],
  base: TacticalSnapshot,
): TacticalSnapshot {
  let itemCount = 0;
  let completed = false;
  let failed = false;
  let errorText: string | null = null;
  for (const msg of messages) {
    if (
      msg.type === 'tool_call' &&
      typeof msg.metadata?.toolName === 'string' &&
      msg.metadata.toolName === 'add_plan_item'
    ) {
      itemCount += 1;
      continue;
    }
    if (msg.type === 'completion') {
      completed = true;
      continue;
    }
    if (msg.type === 'error') {
      failed = true;
      if (!errorText && typeof msg.content === 'string' && msg.content.length) {
        errorText = msg.content;
      }
    }
  }

  // Prefer the snapshot's starting itemCount if it exceeds what we've
  // counted from the live stream (the snapshot already counted pre-mount
  // messages that the SSE snapshot may or may not replay, depending on
  // how many landed before the 200-row cap).
  const effectiveItems = Math.max(base.itemCount, itemCount);

  if (failed) {
    return {
      ...base,
      status: 'failed',
      itemCount: effectiveItems,
      error: errorText ?? base.error,
    };
  }
  if (completed) {
    return {
      ...base,
      status: 'completed',
      itemCount: effectiveItems,
      error: null,
    };
  }
  if (effectiveItems > base.itemCount || base.status === 'pending') {
    // Upgrade pending → running when any add_plan_item lands, or keep
    // running with a fresher count.
    return {
      ...base,
      status: base.status === 'pending' && effectiveItems === 0
        ? 'pending'
        : 'running',
      itemCount: effectiveItems,
    };
  }
  return { ...base, itemCount: effectiveItems };
}

/* ─── Visibility gate ────────────────────────────────────────────────── */

const RIBBON_TTL_MS = 24 * 60 * 60 * 1000;
const SUCCESS_GRACE_MS = 5_000;
const TICKER_TTL_MS = 30_000;

function shouldRemainVisible(
  fromOnboarding: boolean,
  state: ViewState,
  toolProgress: ToolProgressViewState,
  tacticalCollapsedAt: number | null,
): boolean {
  const t = state.tactical.status;
  if (t === 'running' || t === 'failed') return true;
  if (t === 'pending' && fromOnboarding) return true;
  if (t === 'completed') {
    if (tacticalCollapsedAt === null) return true;
    if (Date.now() - tacticalCollapsedAt < SUCCESS_GRACE_MS) return true;
  }
  if (Object.keys(toolProgress.calibration).length > 0) return true;
  if (Object.keys(toolProgress.discovery).length > 0) return true;
  if (toolProgress.ticker && Date.now() - toolProgress.ticker.ts < TICKER_TTL_MS) return true;
  return false;
}

/* ─── Component ──────────────────────────────────────────────────────── */

export function TacticalProgressCard() {
  const searchParams = useSearchParams();
  const fromOnboardingQuery = searchParams?.get('from') === 'onboarding';
  const [fromOnboardingSession, setFromOnboardingSession] = useState(false);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [toolProgress, setToolProgress] = useState<ToolProgressViewState>(INITIAL_TOOL_PROGRESS);
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

  // Generic tool_progress feed — routes events by toolName to calibration,
  // discovery, or the activity ticker.
  const handleAgentsEvent = useCallback((data: unknown) => {
    if (
      !data ||
      typeof data !== 'object' ||
      !('type' in data) ||
      (data as { type: unknown }).type !== 'tool_progress'
    ) {
      return;
    }
    setToolProgress((prev) => reduceToolProgress(prev, data as ToolProgressEventInput));
  }, []);
  useSSEChannel('agents', handleAgentsEvent);

  // Tactical live feed — subscribe to the team's /api/team/events stream
  // when we know the teamId + runId. `useTeamEvents` no-ops when teamId is
  // falsy, so this is safe pre-snapshot.
  const teamId = view.teamRun?.teamId ?? '';
  const runId = view.teamRun?.runId ?? null;
  const tacticalFilter = useCallback((msg: TeamActivityMessage) => {
    return (
      msg.type === 'tool_call' ||
      msg.type === 'completion' ||
      msg.type === 'error'
    );
  }, []);
  const { messages: teamMessages } = useTeamEvents({
    teamId,
    runId,
    filter: tacticalFilter,
  });

  // Fold live team_messages into the tactical snapshot. We re-derive from
  // the snapshot baseline each time — the hook already dedupes by id and
  // keeps messages sorted, so this is O(n) per render, cheap at n ≤ 200.
  const snapshotTacticalRef = useRef<TacticalSnapshot>(view.tactical);
  useEffect(() => {
    if (view.snapshotLoaded) {
      snapshotTacticalRef.current = {
        // Snapshot values are the floor; live messages can only progress.
        ...view.tactical,
      };
    }
    // We intentionally do NOT depend on `view.tactical` here — we only
    // want to capture the snapshot baseline once per snapshotLoaded flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.snapshotLoaded]);

  useEffect(() => {
    if (!view.snapshotLoaded) return;
    if (!view.teamRun) return;
    const derived = deriveTacticalFromMessages(
      teamMessages,
      snapshotTacticalRef.current,
    );
    setView((prev) =>
      prev.tactical.status === derived.status &&
      prev.tactical.itemCount === derived.itemCount &&
      prev.tactical.error === derived.error
        ? prev
        : { ...prev, tactical: derived },
    );
  }, [teamMessages, view.snapshotLoaded, view.teamRun]);

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
      shouldRemainVisible(fromOnboarding, view, toolProgress, tacticalCollapsedAtRef.current),
    [dismissed, fromOnboarding, view, toolProgress],
  );

  if (!visible) return null;

  const calibrationRows = Object.values(toolProgress.calibration);
  const discoveryRows = Object.values(toolProgress.discovery);
  const showTactical =
    view.tactical.status === 'running' ||
    view.tactical.status === 'failed' ||
    view.tactical.status === 'completed' ||
    (view.tactical.status === 'pending' && fromOnboarding);

  const showDismiss =
    view.tactical.status === 'completed' &&
    calibrationRows.length === 0 &&
    discoveryRows.length === 0 &&
    !toolProgress.ticker;

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
      <CalibrationSection rows={calibrationRows} hasTacticalDivider={showTactical} />
      <DiscoverySection rows={discoveryRows} hasDivider={showTactical || calibrationRows.length > 0} />
      <ActivityTicker
        row={toolProgress.ticker}
        hasDivider={showTactical || calibrationRows.length > 0 || discoveryRows.length > 0}
      />
      {showDismiss && <DismissHandle onDismiss={() => setDismissed(true)} />}
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
  rows: CalibrationRow[];
  hasTacticalDivider: boolean;
}) {
  if (rows.length === 0) return null;
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
  const precisionText =
    row.precision === null ? '—' : row.precision.toFixed(2);
  const roundText = row.maxTurns
    ? `Round ${row.round ?? '?'}/${row.maxTurns}`
    : `Round ${row.round ?? '?'}`;

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
          background: 'var(--sf-accent)',
          animation: 'sfTacticalPulse 1400ms ease-in-out infinite',
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
      <OnbMono color="var(--sf-fg-3)">Calibrating</OnbMono>
      <span style={{ flex: 1 }} />
      <OnbMono color="var(--sf-fg-4)">{roundText}</OnbMono>
      <OnbMono color="var(--sf-fg-4)">Precision {precisionText}</OnbMono>
    </div>
  );
}

/* ─── Discovery section ──────────────────────────────────────────────── */

function DiscoverySection({
  rows,
  hasDivider,
}: {
  rows: DiscoveryRow[];
  hasDivider: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      style={{
        padding: '14px 20px',
        borderTop: hasDivider ? '1px solid rgba(0,0,0,0.06)' : undefined,
      }}
    >
      <OnbMono style={{ marginBottom: 10, display: 'inline-block' }}>
        Discovery
      </OnbMono>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div
            key={r.platform}
            style={{
              fontSize: 13,
              color: 'var(--sf-fg-2)',
              letterSpacing: '-0.16px',
            }}
          >
            <strong style={{ color: 'var(--sf-fg-1)' }}>
              {PLATFORMS[r.platform]?.displayName ?? r.platform}
            </strong>{' '}
            · {r.message}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Activity ticker ────────────────────────────────────────────────── */

function ActivityTicker({
  row,
  hasDivider,
}: {
  row: TickerRow | null;
  hasDivider: boolean;
}) {
  if (!row) return null;
  return (
    <div
      style={{
        padding: '10px 20px',
        borderTop: hasDivider ? '1px solid rgba(0,0,0,0.06)' : undefined,
        fontSize: 12,
        color: 'var(--sf-fg-3)',
        fontFamily: 'var(--sf-font-mono, monospace)',
        letterSpacing: 'var(--sf-track-mono)',
      }}
    >
      {row.message}
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
      // The team events stream will emit a completion or error message
      // when the worker finishes; the tactical section updates accordingly.
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
