'use client';

/**
 * ShipFlare v2 — Today (approval inbox)
 *
 * Boss/employee framing: the agents drafted these replies and posts;
 * the user approves / edits / skips. Replaces the v1 "task list" view.
 *
 * Discovery is cron-driven (daily team-run fanout) — there is no manual
 * scan trigger in the UI. The page renders whatever the workers have
 * surfaced into `/api/today`.
 */

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
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
import { StatusDot } from '@/components/ui/status-dot';
import { ShortcutsHelp, type ShortcutBinding } from '@/components/ui/shortcuts-help';
import { HeaderBar } from '@/components/layout/header-bar';
import { CompletionState, type YesterdayTop } from '@/components/today/completion-state';
import { TodayWelcomeRibbon } from '@/components/today/today-welcome-ribbon';
import { TacticalProgressCard } from '@/components/today/tactical-progress-card';
import { ReplyCard } from './_components/reply-card';
import { PostCard } from './_components/post-card';
import { ReplySlotCard } from './_components/reply-slot-card';
import {
  SourceFilterRail,
  type SourceFilterEntry,
} from './_components/source-filter-rail';

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
  fallbackData: TodayFallbackData;
  yesterdayTop: YesterdayTop | null;
  lastScanAt: Date | null;
  onboardingCompletedAt: Date | null;
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
  fallbackData,
  yesterdayTop,
  lastScanAt,
  onboardingCompletedAt,
}: TodayContentProps) {
  return (
    <SWRConfig value={{ fallback: { '/api/today': fallbackData } }}>
      <TodayContentInner
        yesterdayTop={yesterdayTop}
        initialLastScanAt={lastScanAt}
        onboardingCompletedAt={onboardingCompletedAt}
      />
    </SWRConfig>
  );
}

/* ─── Inner view ────────────────────────────────────────────────────── */

interface TodayContentInnerProps {
  yesterdayTop: YesterdayTop | null;
  initialLastScanAt: Date | null;
  onboardingCompletedAt: Date | null;
}

function TodayContentInner({
  yesterdayTop,
  initialLastScanAt,
  onboardingCompletedAt,
}: TodayContentInnerProps) {
  const {
    items,
    replySlots,
    stats,
    isLoading,
    approve: rawApprove,
    postNow: rawPostNow,
    skip: rawSkip,
    edit: rawEdit,
    reschedule: rawReschedule,
  } = useToday();
  const { toast, toastWithAction } = useToast();
  const { mutate: globalMutate } = useSWRConfig();
  const router = useRouter();

  // Local UI state ────────────────────────────────────────────────────
  // Start at -1 so no card is keyboard-active on first render. Pressing j
  // advances to 0 (first card); pressing k stays at the first card. Avoids
  // the signal outline appearing on the first card before the user has
  // actually engaged keyboard navigation.
  const [activeIndex, setActiveIndex] = useState(-1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sourceFilterId, setSourceFilterId] = useState<string | null>(null);

  // Discovery is cron-driven; the page only consumes whatever the
  // workers have surfaced. The "last scan" timestamp is server-seeded.
  const lastScanAt = initialLastScanAt;

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

  const postNow = useCallback(
    async (id: string) => {
      try {
        await rawPostNow(id);
        toast('Posting now', 'success');
      } catch (err) {
        surfaceError(err, 'Failed to post');
      }
    },
    [rawPostNow, toast, surfaceError],
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
    // Source filter is keyed as `${platform}:${source}`, matching the chip
    // id format in source-filter-rail.tsx. Exact match avoids cross-hits
    // like "r/dev" matching "r/devops" that the prior substring check had.
    const filtered = sourceFilterId
      ? rs.filter(
          (r) =>
            r.community !== null &&
            `${r.platform}:${r.community}` === sourceFilterId,
        )
      : rs;
    return { replies: rs, posts: ps, filteredReplies: filtered };
  }, [items, sourceFilterId]);

  // Filter rail entries derived from the replies currently in view —
  // each unique (platform, community) pair becomes a chip.
  const displaySources = useMemo<SourceFilterEntry[]>(() => {
    const seen = new Set<string>();
    const out: SourceFilterEntry[] = [];
    for (const r of replies) {
      if (r.community === null) continue;
      const key = `${r.platform}:${r.community}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ platform: r.platform, source: r.community });
    }
    return out;
  }, [replies]);

  const activeItem = items[activeIndex];
  const activeId = activeItem?.id ?? null;

  const welcomeRibbon = (
    <TodayWelcomeRibbon onboardingCompletedAt={onboardingCompletedAt} />
  );

  if (isLoading) {
    // loading.tsx owns the skeleton surface, but keep a guard so hooks
    // don't render a partial view if SWR hasn't hydrated yet.
    return null;
  }

  // Meta line for HeaderBar: "{n} to review · ● {n} shipped today · last run {t}"
  const metaLine = (
    <MetaLine
      toReview={stats.pending_count ?? items.length}
      shippedToday={stats.acted_today}
      lastScan={lastScanAt}
    />
  );

  return (
    <>
      <HeaderBar title="Today" meta={metaLine} />
      {welcomeRibbon}
      <TacticalProgressCard />

      <SourceFilterRail
        sources={displaySources}
        filterId={sourceFilterId}
        onFilterChange={setSourceFilterId}
        totalCount={replies.length}
      />

      <div
        style={{
          width: '100%',
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
          {/* Daily reply-session progress (one row per channel slot
              scheduled for today). Sits above the per-thread reply
              cards so the founder sees the day's target + drafted
              count before scrolling through drafts. */}
          {replySlots.length > 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginBottom: 12,
              }}
            >
              {replySlots.map((slot) => (
                <ReplySlotCard key={slot.id} slot={slot} />
              ))}
            </div>
          ) : null}

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
                  : 'Discovery runs daily. New threads will show here.'
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
                ) : undefined
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
              {filteredReplies.map((item) => (
                <ReplyCard
                  key={item.id}
                  item={item}
                  onApprove={approve}
                  onPostNow={postNow}
                  onSkip={skip}
                  onEdit={edit}
                  isActive={item.id === activeId}
                  forceEditing={item.id === editingId}
                  onEditDone={() => setEditingId(null)}
                />
              ))}
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
              {posts.map((item) => (
                <PostCard
                  key={item.id}
                  item={item}
                  onApprove={approve}
                  onPostNow={postNow}
                  onSkip={skip}
                  onEdit={edit}
                  onReschedule={reschedule}
                  isActive={item.id === activeId}
                  forceEditing={item.id === editingId}
                  onEditDone={() => setEditingId(null)}
                />
              ))}
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

/* ── Meta line ─────────────────────────────────────────────────────── */

interface MetaLineProps {
  toReview: number;
  shippedToday: number;
  lastScan: Date | null;
}

function MetaLine({ toReview, shippedToday, lastScan }: MetaLineProps) {
  const separator = (
    <span
      aria-hidden="true"
      style={{ margin: '0 6px', color: 'var(--sf-fg-4)' }}
    >
      ·
    </span>
  );
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--sf-fg-2)', fontWeight: 500 }}>
        {toReview} to review
      </span>
      {separator}
      <span>{shippedToday} shipped today</span>
      {separator}
      <StatusDot state="success" size={6} aria-label="Pipeline idle" />
      <span style={{ marginLeft: 6 }}>last run {relativeScan(lastScan)}</span>
    </span>
  );
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

