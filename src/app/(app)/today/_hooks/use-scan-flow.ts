'use client';

/**
 * ShipFlare v2 — scan flow state machine.
 *
 * Owns the lifecycle of a manual "Scan now" click:
 *  1. POST /api/discovery/scan (BullMQ fan-out)
 *  2. Subscribe to the discovery progressive stream (SSE via useSSEChannel)
 *  3. Derive per-chip state and a coarse ThoughtStream index from real
 *     worker events. No setTimeout fake progress.
 *  4. Surface "complete" exactly once, with the freshly-drafted reply IDs
 *     so the view can mark them isNew and stagger-reveal.
 *
 * Also handles resume-after-reload: if a scanRunId is persisted in
 * localStorage, call /api/discovery/scan-status on mount and resume the
 * subscription if any source is still queued/searching.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyedMutator } from 'swr';
import { useProgressiveStream } from '@/hooks/use-progressive-stream';
import type { SourceChipData } from '@/components/today/source-chip';

export type ScanSource = { platform: string; source: string };

export interface ScanFlowState {
  runId: string | null;
  sources: ScanSource[];
  /**
   * Coarse progress through the ThoughtStream narrative. Maps to:
   *   0 Gathering context
   *   1 Searching sources
   *   2 Scoring candidates
   *   3 Drafting replies
   * `-1` means scan hasn't started; `4` means all four steps done.
   */
  thoughtIdx: number;
  /** Drawer visibility. Independent of worker state: Escape can hide without aborting. */
  drawerOpen: boolean;
  /** True while the underlying BullMQ pipeline still has unfinished sources. */
  isRunning: boolean;
  /** The set of todo IDs that arrived on the latest scan completion — used for NewCardReveal. */
  newTodoIds: Set<string>;
  /** When the most recent scan finished (wall clock). */
  lastScanAt: Date | null;
}

export interface ScanResponseBody {
  scanRunId: string;
  platforms: string[];
  sources: ScanSource[];
  status?: string;
}

interface RateLimitBody {
  error: 'rate_limited';
  retryAfterSeconds: number;
}

interface ScanErrorBody {
  error: string;
}

export type StartScanResult =
  | { ok: true; runId: string; sources: ScanSource[] }
  | { ok: false; kind: 'rate_limited'; retryAfterSeconds: number }
  | { ok: false; kind: 'error'; message: string };

interface UseScanFlowOptions<T> {
  /** SWR mutator for `/api/today` so we can re-fetch on completion. */
  mutateToday: KeyedMutator<T>;
  /** IDs present on the card list before the scan fired. Used to diff new items. */
  existingIdsRef: React.RefObject<Set<string>>;
  /** Emitted when a scan finishes and new items have been fetched. */
  onComplete?: (summary: { newCount: number; failed: boolean }) => void;
  /** Emitted as soon as the scan is successfully enqueued. */
  onStarted?: (runId: string, sources: ScanSource[]) => void;
}

const STORAGE_RUN_KEY = 'shipflare:lastScanRunId';
const STORAGE_AT_KEY = 'shipflare:lastScanAt';

function readInitialLastScanAt(): Date | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_AT_KEY);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Derive which ThoughtStream step we're on from the live chip state map.
 * Mapping:
 *   no source has started → 0 (Gathering — conceptually the "post scan"
 *     phase while the worker is bootstrapping)
 *   any source searching, none searched → 1 (Searching)
 *   >= half searched            → 2 (Scoring — server-side ranking)
 *   all terminal, any searched  → 3 (Drafting — content pipeline)
 *   all terminal and we saw completion → 4
 */
function deriveThoughtIdx(
  sources: ScanSource[],
  chipState: Map<string, { state: string }>,
  fullyComplete: boolean,
): number {
  if (sources.length === 0) return -1;
  if (fullyComplete) return 4;

  let searched = 0;
  let searching = 0;
  let terminal = 0;
  for (const s of sources) {
    const id = `${s.platform}:${s.source}`;
    const entry = chipState.get(id);
    const state = entry?.state ?? 'queued';
    if (state === 'searched') {
      searched += 1;
      terminal += 1;
    } else if (state === 'failed') {
      terminal += 1;
    } else if (state === 'searching') {
      searching += 1;
    }
  }

  if (terminal === sources.length && searched > 0) return 3;
  if (searched >= Math.ceil(sources.length / 2)) return 2;
  if (searching > 0 || searched > 0) return 1;
  return 0;
}

export function useScanFlow<T>({
  mutateToday,
  existingIdsRef,
  onComplete,
  onStarted,
}: UseScanFlowOptions<T>) {
  const [runId, setRunId] = useState<string | null>(null);
  const [sources, setSources] = useState<ScanSource[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newTodoIds, setNewTodoIds] = useState<Set<string>>(() => new Set());
  const [lastScanAt, setLastScanAt] = useState<Date | null>(
    readInitialLastScanAt,
  );

  // Guard so onComplete fires exactly once per run.
  const completedRunRef = useRef<string | null>(null);
  // Pin the pre-scan ID set so diffing works even if React re-renders mid-scan.
  const baselineIdsRef = useRef<Set<string> | null>(null);

  const { items: chipState } = useProgressiveStream<SourceChipData>('discovery');

  // Derived "is this scan still running" flag.
  const isRunning = useMemo(() => {
    if (!runId || sources.length === 0) return false;
    for (const s of sources) {
      const id = `${s.platform}:${s.source}`;
      const entry = chipState.get(id);
      const state = entry?.state ?? 'queued';
      if (state === 'queued' || state === 'searching') return true;
    }
    return false;
  }, [runId, sources, chipState]);

  const fullyComplete =
    runId !== null && sources.length > 0 && !isRunning;

  const thoughtIdx = useMemo(
    () => deriveThoughtIdx(sources, chipState, fullyComplete),
    [sources, chipState, fullyComplete],
  );

  // Fire onComplete exactly once when a scan transitions to complete.
  useEffect(() => {
    if (!fullyComplete || !runId) return;
    if (completedRunRef.current === runId) return;
    completedRunRef.current = runId;

    // Check for all-failed state for error toast branching.
    let anyFailed = false;
    let anySearched = false;
    for (const s of sources) {
      const id = `${s.platform}:${s.source}`;
      const entry = chipState.get(id);
      if (entry?.state === 'failed') anyFailed = true;
      if (entry?.state === 'searched') anySearched = true;
    }
    const allFailed = anyFailed && !anySearched;

    let cancelled = false;
    (async () => {
      const next = await mutateToday();
      if (cancelled) return;
      // mutateToday returns the re-fetched payload; diff IDs vs. baseline.
      const items =
        (next as unknown as { items?: Array<{ id: string }> } | undefined)
          ?.items ?? [];
      const prev = baselineIdsRef.current ?? new Set<string>();
      const fresh = new Set<string>();
      for (const it of items) {
        if (!prev.has(it.id)) fresh.add(it.id);
      }
      setNewTodoIds(fresh);
      setLastScanAt(new Date());
      try {
        window.localStorage.setItem(STORAGE_AT_KEY, new Date().toISOString());
      } catch {
        // localStorage may be unavailable (privacy mode); non-fatal.
      }
      onComplete?.({ newCount: fresh.size, failed: allFailed });
    })().catch(() => {
      // Surface nothing here — the outer caller's onComplete handler can
      // decide whether to show an error toast. We only own success-path state.
    });
    return () => {
      cancelled = true;
    };
  }, [fullyComplete, runId, sources, chipState, mutateToday, onComplete]);

  // Resume a scan across reload. Best-effort: if the saved run is already
  // terminal, we drop it so the chips don't resurrect stale state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(STORAGE_RUN_KEY);
    if (!saved) return;
    let cancelled = false;
    fetch(`/api/discovery/scan-status?scanRunId=${encodeURIComponent(saved)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          body:
            | {
                sources?: Array<{
                  platform: string;
                  source: string;
                  state: string;
                }>;
              }
            | null,
        ) => {
          if (cancelled || !body?.sources?.length) return;
          const active = body.sources.some(
            (s) => s.state === 'queued' || s.state === 'searching',
          );
          if (!active) return;
          setRunId(saved);
          setSources(
            body.sources.map(({ platform, source }) => ({ platform, source })),
          );
          // Don't re-open the drawer on resume — the user may already be
          // mid-review and popping a cinematic drawer on mount is jarring.
        },
      )
      .catch(() => {
        // Silently ignore — resume is a nicety.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startScan = useCallback(async (): Promise<StartScanResult> => {
    // Snapshot baseline IDs *before* we reset chip state / fetch anything.
    baselineIdsRef.current = new Set(existingIdsRef.current);
    completedRunRef.current = null;
    setNewTodoIds(new Set());

    const res = await fetch('/api/discovery/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as Partial<RateLimitBody>;
      return {
        ok: false,
        kind: 'rate_limited',
        retryAfterSeconds: body.retryAfterSeconds ?? 60,
      };
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Partial<ScanErrorBody>;
      return {
        ok: false,
        kind: 'error',
        message: body.error ?? `Scan failed (${res.status})`,
      };
    }
    const body = (await res.json()) as ScanResponseBody;
    setRunId(body.scanRunId);
    setSources(body.sources);
    setDrawerOpen(true);
    try {
      window.localStorage.setItem(STORAGE_RUN_KEY, body.scanRunId);
    } catch {
      // non-fatal
    }
    onStarted?.(body.scanRunId, body.sources);
    return { ok: true, runId: body.scanRunId, sources: body.sources };
  }, [existingIdsRef, onStarted]);

  const retrySource = useCallback(
    async (platform: string, source: string) => {
      if (!runId) return;
      await fetch('/api/discovery/retry-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanRunId: runId, platform, source }),
      }).catch(() => {
        // Surface-less — the chip will flip back to failed on its own.
      });
    },
    [runId],
  );

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const clearNewIds = useCallback(() => {
    setNewTodoIds(new Set());
  }, []);

  const state: ScanFlowState = {
    runId,
    sources,
    thoughtIdx,
    drawerOpen,
    isRunning,
    newTodoIds,
    lastScanAt,
  };

  return {
    state,
    startScan,
    retrySource,
    closeDrawer,
    clearNewIds,
    /** Per-chip state snapshots keyed by `${platform}:${source}`. */
    chipState,
  };
}
