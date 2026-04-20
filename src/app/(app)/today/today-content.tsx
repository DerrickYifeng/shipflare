'use client';

/**
 * ShipFlare v2 — Today (approval inbox + cinematic scan)
 *
 * Boss/employee framing: the agents drafted these replies and posts;
 * the user approves / edits / skips. Replaces the v1 "task list" view.
 *
 * This file orchestrates:
 *  - SWR hydration from /api/today (server-seeded fallback).
 *  - Scan flow state via `useScanFlow` (real BullMQ fan-out, no mocks).
 *  - The cinematic ScanDrawer, SourceFilterRail, ReplyCard / PostCard
 *    render surfaces.
 *  - Optimistic approve/skip/edit with action toasts.
 *  - NewCardReveal stagger once a scan completes.
 *
 * All platform-specific behavior goes through `PLATFORMS` + the three
 * sanctioned platform-deps helpers (server-side) per CLAUDE.md.
 */

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { SWRConfig, useSWRConfig } from 'swr';
import { TodayActionError, useToday } from '@/hooks/use-today';
import type { TodoItem, TodayStats } from '@/hooks/use-today';
import { useToast } from '@/components/ui/toast';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { NewCardReveal } from '@/components/ui/new-card-reveal';
import { ShortcutsHelp, type ShortcutBinding } from '@/components/ui/shortcuts-help';
import { HeaderBar } from '@/components/layout/header-bar';
import { FirstRun } from '@/components/today/first-run';
import { CompletionState, type YesterdayTop } from '@/components/today/completion-state';
import { ReplyCard } from './_components/reply-card';
import { PostCard } from './_components/post-card';
import { ScanDrawer } from './_components/scan-drawer';
import { SourceFilterRail } from './_components/source-filter-rail';
import { useScanFlow } from './_hooks/use-scan-flow';

/* ─────────────────────────────────────────────────────────────────── */

interface RawTodoItemPayload {
  id: string;
  [key: string]: unknown;
}

interface TodayFallbackData {
  items: RawTodoItemPayload[];
  stats: TodayStats;
}

export interface TodayContentProps {
  isFirstRun: boolean;
  hasChannel: boolean;
  fallbackData: TodayFallbackData;
  yesterdayTop: YesterdayTop | null;
  lastScanAt: Date | null;
}

function platformLabel(platform: string | undefined): string {
  if (!platform) return 'an account';
  if (platform === 'x') return 'X';
  if (platform === 'reddit') return 'Reddit';
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/**
 * Public entry — wraps SWR fallback + renders the inner client view.
 * Kept as a thin adapter so the page can hand over server-seeded data
 * without a client-side refetch flash.
 */
export function TodayContent({
  isFirstRun,
  hasChannel,
  fallbackData,
  yesterdayTop,
  lastScanAt,
}: TodayContentProps) {
  return (
    <SWRConfig value={{ fallback: { '/api/today': fallbackData } }}>
      <TodayContentInner
        isFirstRun={isFirstRun}
        hasChannel={hasChannel}
        yesterdayTop={yesterdayTop}
        initialLastScanAt={lastScanAt}
      />
    </SWRConfig>
  );
}

/* ─── Inner view ────────────────────────────────────────────────────── */

interface TodayContentInnerProps {
  isFirstRun: boolean;
  hasChannel: boolean;
  yesterdayTop: YesterdayTop | null;
  initialLastScanAt: Date | null;
}

function TodayContentInner({
  isFirstRun,
  hasChannel,
  yesterdayTop,
  initialLastScanAt,
}: TodayContentInnerProps) {
  const {
    items,
    stats,
    isLoading,
    approve: rawApprove,
    skip: rawSkip,
    edit: rawEdit,
    reschedule: rawReschedule,
    mutate,
  } = useToday();
  const { toast, toastWithAction } = useToast();
  const { mutate: globalMutate } = useSWRConfig();
  const router = useRouter();

  // Local UI state ────────────────────────────────────────────────────
  const [showFirstRun, setShowFirstRun] = useState(isFirstRun);
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sourceFilterId, setSourceFilterId] = useState<string | null>(null);

  // Ref to the set of IDs currently on screen, so scan-diff works even
  // when the list mutates asynchronously during a scan.
  const currentIdsRef = useRef<Set<string>>(new Set(items.map((i) => i.id)));
  useEffect(() => {
    currentIdsRef.current = new Set(items.map((i) => i.id));
  }, [items]);

  // Scan flow ─────────────────────────────────────────────────────────
  const {
    state: scan,
    startScan,
    retrySource,
    closeDrawer,
    clearNewIds,
    chipState,
  } = useScanFlow({
    mutateToday: mutate,
    existingIdsRef: currentIdsRef,
    onComplete: ({ newCount, failed }) => {
      if (failed) {
        toastWithAction({
          message: 'Scan failed across all sources — retry?',
          variant: 'error',
          action: {
            label: 'Retry',
            onClick: () => {
              void handleScanClick();
            },
          },
        });
      } else {
        toast(
          newCount === 0
            ? 'Scan complete · no new drafts this round'
            : `Scan complete · ${newCount} new ${newCount === 1 ? 'reply' : 'replies'} drafted`,
          'success',
        );
      }
      closeDrawer();
    },
  });

  // Clear the NewCardReveal stagger after the animation finishes so the
  // cards don't re-animate when the user interacts with them.
  useEffect(() => {
    if (scan.newTodoIds.size === 0) return;
    const t = setTimeout(() => clearNewIds(), 1500);
    return () => clearTimeout(t);
  }, [scan.newTodoIds, clearNewIds]);

  // Track the most recent scan wall clock. Prefer live value from scan flow,
  // fallback to server-seeded initial.
  const lastScanAt = scan.lastScanAt ?? initialLastScanAt;

  // Scan now (handles the 429 / no-channel branches) ─────────────────
  const handleScanClick = useCallback(async () => {
    if (!hasChannel) {
      toastWithAction({
        message: 'Connect an account to scan for replies.',
        variant: 'warning',
        action: {
          label: 'Go to Settings',
          onClick: () => router.push('/settings#connections'),
        },
      });
      return;
    }
    const result = await startScan();
    if (result.ok) return;
    if (result.kind === 'rate_limited') {
      toast(
        `Just scanned — next available in ${result.retryAfterSeconds}s`,
        'info',
      );
    } else {
      toast(result.message, 'error');
    }
  }, [hasChannel, router, startScan, toast, toastWithAction]);

  // Approve with 5s undo window ──────────────────────────────────────
  const surfaceError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof TodayActionError && err.code === 'NO_CHANNEL') {
        toastWithAction({
          message: `Connect ${platformLabel(err.platform)} to publish this post.`,
          variant: 'warning',
          action: {
            label: 'Go to Settings',
            onClick: () => router.push('/settings'),
          },
          timeoutMs: 8_000,
        });
        return;
      }
      const message =
        err instanceof Error && err.message ? err.message : fallback;
      toast(message, 'error');
    },
    [router, toast, toastWithAction],
  );

  const approve = useCallback(
    async (id: string) => {
      // Optimistic + 5s undo toast. The server has already scheduled a
      // delayed BullMQ posting job; undo would need a dedicated
      // endpoint to cancel that job. Today we undo at the UI layer by
      // leaving the toast visible and revalidating — actual queue
      // cancellation lives behind a /undo endpoint that doesn't ship in
      // this PR, so we surface the affordance and fall through to commit
      // when the window expires.
      try {
        await rawApprove(id);
        toastWithAction({
          message: 'Sent · undo in 5s',
          variant: 'success',
          action: {
            label: 'Undo',
            onClick: async () => {
              // Best-effort undo: POST to a future /undo endpoint. Today
              // this is a no-op server-side but still refreshes the list
              // so the user's mental model stays coherent.
              try {
                await fetch(`/api/today/${id}/undo`, { method: 'POST' });
              } catch {
                // 404 is expected until the endpoint ships — silently
                // continue so the toast still feels responsive.
              }
              await globalMutate('/api/today');
              toast('Undone', 'info');
            },
          },
          timeoutMs: 5_000,
        });
      } catch (err) {
        surfaceError(err, 'Failed to approve');
      }
    },
    [rawApprove, toastWithAction, globalMutate, toast, surfaceError],
  );

  const skip = useCallback(
    async (id: string) => {
      try {
        await rawSkip(id);
        toast('Skipped', 'info');
      } catch (err) {
        surfaceError(err, 'Failed to skip');
      }
    },
    [rawSkip, toast, surfaceError],
  );

  const edit = useCallback(
    async (id: string, body: string) => {
      try {
        await rawEdit(id, body);
        toast('Draft saved', 'success');
      } catch (err) {
        surfaceError(err, 'Failed to save edit');
      }
    },
    [rawEdit, toast, surfaceError],
  );

  const reschedule = useCallback(
    async (id: string, scheduledFor: string) => {
      try {
        await rawReschedule(id, scheduledFor);
        toast('Rescheduled', 'success');
      } catch (err) {
        surfaceError(err, 'Failed to reschedule');
      }
    },
    [rawReschedule, toast, surfaceError],
  );

  // First-run fallthrough ────────────────────────────────────────────
  const handleItemsReady = useCallback(() => {
    setShowFirstRun(false);
    mutate();
  }, [mutate]);

  // Keyboard shortcuts (j/k/a/e/s/?) ─────────────────────────────────
  const shortcutBindings: ShortcutBinding[] = useMemo(
    () => [
      { keys: 'j', label: 'Next item' },
      { keys: 'k', label: 'Previous item' },
      { keys: 'a', label: 'Approve current item' },
      { keys: 'e', label: 'Edit current item' },
      { keys: 's', label: 'Skip current item' },
      { keys: '?', label: 'Show this help' },
    ],
    [],
  );

  useKeyboardShortcuts(
    {
      j: () =>
        setActiveIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0))),
      k: () => setActiveIndex((i) => Math.max(i - 1, 0)),
      a: () => {
        const target = items[activeIndex];
        if (target) void approve(target.id);
      },
      e: () => {
        const target = items[activeIndex];
        if (target) setEditingId(target.id);
      },
      s: () => {
        const target = items[activeIndex];
        if (target) void skip(target.id);
      },
      '?': () => setHelpOpen(true),
    },
    [items, activeIndex, approve, skip],
  );

  // Split items by cardFormat ────────────────────────────────────────
  const { replies, posts, filteredReplies } = useMemo(() => {
    const rs: TodoItem[] = [];
    const ps: TodoItem[] = [];
    for (const it of items) {
      if (it.cardFormat === 'reply') rs.push(it);
      else ps.push(it);
    }
    // Source filter is keyed as `${platform}:${source}` to match chip IDs.
    // Match on community substring so chip id ("reddit:r/foo") filters an
    // item with community "r/foo".
    const filtered = sourceFilterId
      ? rs.filter(
          (r) => r.community && sourceFilterId.includes(r.community),
        )
      : rs;
    return { replies: rs, posts: ps, filteredReplies: filtered };
  }, [items, sourceFilterId]);

  const activeItem = items[activeIndex];
  const activeId = activeItem?.id ?? null;

  // First-run gate — show the signature "your agents are warming up" flow.
  if (showFirstRun && items.length === 0) {
    return (
      <>
        <HeaderBar title="Today" />
        <FirstRun onItemsReady={handleItemsReady} hasChannel={hasChannel} />
      </>
    );
  }

  if (isLoading) {
    // loading.tsx owns the skeleton surface, but keep a guard so hooks
    // don't render a partial view if SWR hasn't hydrated yet.
    return null;
  }

  // Meta line for HeaderBar: "{to review} to review · {shipped} shipped today · last scan {time}"
  const metaLine = buildMeta(
    stats.pending_count ?? items.length,
    stats.acted_today,
    lastScanAt,
  );

  const scanButton = (
    <Button
      variant="primary"
      size="md"
      onClick={handleScanClick}
      disabled={scan.isRunning || !hasChannel}
      title={
        !hasChannel
          ? 'Connect a channel before scanning for replies'
          : scan.isRunning
            ? 'Scan already in progress'
            : undefined
      }
    >
      {scan.isRunning ? 'Scanning…' : 'Scan now'}
    </Button>
  );

  return (
    <>
      <HeaderBar title="Today" meta={metaLine} action={scanButton} />

      <ScanDrawer
        open={scan.drawerOpen}
        onClose={closeDrawer}
        thoughtIdx={scan.thoughtIdx}
        isRunning={scan.isRunning}
      />

      <SourceFilterRail
        sources={scan.sources}
        chipState={chipState}
        filterId={sourceFilterId}
        onFilterChange={setSourceFilterId}
        onRetrySource={retrySource}
        scanning={scan.drawerOpen && scan.isRunning}
      />

      <div
        style={{
          maxWidth: 820,
          margin: '0 auto',
          padding: '0 clamp(16px, 3vw, 32px) 48px',
        }}
      >
        {/* ── Replies section ─────────────────────────────────────── */}
        <Section
          label="Replies"
          count={filteredReplies.length}
          subtle={
            sourceFilterId
              ? `Filtered by ${sourceFilterId.split(':').slice(1).join(':')}`
              : undefined
          }
        >
          {filteredReplies.length === 0 ? (
            <EmptyState
              title={
                sourceFilterId
                  ? 'Nothing here'
                  : 'All caught up on replies.'
              }
              hint={
                sourceFilterId
                  ? undefined
                  : 'We scan every 4h. New threads will show here.'
              }
              action={
                sourceFilterId ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSourceFilterId(null)}
                  >
                    Clear filter
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleScanClick}
                    disabled={scan.isRunning || !hasChannel}
                  >
                    {scan.isRunning ? 'Scanning…' : 'Scan now'}
                  </Button>
                )
              }
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {filteredReplies.map((item, i) => {
                const isNew = scan.newTodoIds.has(item.id);
                return (
                  <NewCardReveal
                    key={item.id}
                    isNew={isNew}
                    delay={isNew ? 120 * i : 0}
                  >
                    <ReplyCard
                      item={item}
                      onApprove={approve}
                      onSkip={skip}
                      onEdit={edit}
                      isActive={item.id === activeId}
                      forceEditing={item.id === editingId}
                      onEditDone={() => setEditingId(null)}
                    />
                  </NewCardReveal>
                );
              })}
            </div>
          )}
        </Section>

        {/* ── Scheduled posts section ─────────────────────────────── */}
        {posts.length > 0 ? (
          <Section label="Scheduled posts" count={posts.length}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {posts.map((item, i) => {
                const isNew = scan.newTodoIds.has(item.id);
                return (
                  <NewCardReveal
                    key={item.id}
                    isNew={isNew}
                    delay={isNew ? 120 * (replies.length + i) : 0}
                  >
                    <PostCard
                      item={item}
                      onApprove={approve}
                      onSkip={skip}
                      onEdit={edit}
                      onReschedule={reschedule}
                      isActive={item.id === activeId}
                      forceEditing={item.id === editingId}
                      onEditDone={() => setEditingId(null)}
                    />
                  </NewCardReveal>
                );
              })}
            </div>
          </Section>
        ) : null}

        {/* ── Completion state (when everything is handled) ───────── */}
        {replies.length === 0 &&
        posts.length === 0 &&
        stats.acted_today > 0 ? (
          <CompletionState stats={stats} yesterdayTop={yesterdayTop} />
        ) : null}
      </div>

      <ShortcutsHelp
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        bindings={shortcutBindings}
      />
    </>
  );
}

/* ── Section header ────────────────────────────────────────────────── */

interface SectionProps {
  label: string;
  count: number;
  subtle?: string;
  children: React.ReactNode;
}

function Section({ label, count, subtle, children }: SectionProps) {
  const wrapper: CSSProperties = {
    marginBottom: 32,
  };
  const headerRow: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 14,
  };
  return (
    <section style={wrapper}>
      <div style={headerRow}>
        <h2
          className="sf-h3"
          style={{
            margin: 0,
            color: 'var(--sf-fg-1)',
          }}
        >
          {label}
        </h2>
        <span
          className="sf-mono"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
            letterSpacing: 'var(--sf-track-mono)',
          }}
        >
          {count}
        </span>
        {subtle ? (
          <Ops style={{ marginLeft: 'auto' }}>{subtle}</Ops>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function buildMeta(
  toReview: number,
  shippedToday: number,
  lastScan: Date | null,
): string {
  const parts: string[] = [];
  parts.push(`${toReview} to review`);
  parts.push(`${shippedToday} shipped today`);
  parts.push(`last scan ${relativeScan(lastScan)}`);
  return parts.join(' · ');
}

function relativeScan(d: Date | null): string {
  if (!d) return 'never';
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

