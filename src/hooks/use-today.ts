'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

/**
 * Error thrown by the today mutations when the server responds with a
 * structured error (e.g. no connected channel). Consumers can branch on
 * `code` to render contextual toasts instead of generic "something failed".
 */
export class TodayActionError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly platform?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TodayActionError';
  }
}

async function postJson(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, init);
  if (res.ok) return;

  let body: { error?: string; code?: string; platform?: string } = {};
  try {
    body = await res.json();
  } catch {
    // Non-JSON response (502/504 from the edge, etc.); fall through to generic.
  }
  throw new TodayActionError(
    body.error ?? `Request failed (${res.status})`,
    body.code,
    body.platform,
    res.status,
  );
}

interface ApproveResponseBody {
  success?: boolean;
  error?: string;
  code?: string;
  platform?: string;
  browserHandoff?: { intentUrl: string };
  queued?: { delayMs: number };
  deferred?: boolean;
  reason?: string;
  retryAfterMs?: number;
}

/**
 * Build a terse, spec-like deferred message in the ShipFlare voice.
 * Examples:
 *   "Daily cap reached — queued for tomorrow"
 *   "Pacer not configured for this platform"
 */
function formatDeferredMessage(reason: string, retryAfterMs: number): string {
  if (reason === 'over_daily_cap') {
    const hours = Math.round(retryAfterMs / (60 * 60 * 1000));
    if (hours <= 1) return 'Daily cap reached — queued for the next slot';
    if (hours < 24) return `Daily cap reached — queued in ${hours}h`;
    return 'Daily cap reached — queued for tomorrow';
  }
  if (reason === 'no_pacer_config') {
    return 'Pacer not configured for this platform';
  }
  return `Posting deferred (${reason})`;
}

/**
 * Optimistic status markers layered on top of the server-side `'pending'`
 * status. The server only ever returns `'pending'` for todos; these extra
 * values are set by the mutation helpers while a request is in flight so
 * the UI can render an inline "sending..." / "skipping..." state instead
 * of ripping the card out of the list (and then re-inserting it on
 * rollback if the action fails).
 */
export type TodoOptimisticStatus =
  | 'pending'
  | 'pending_approval'
  | 'pending_skip'
  | 'pending_reschedule'
  /** Server confirmed the post is queued for posting. UI shows "Post now". */
  | 'queued'
  /** X reply intent URL was opened in a new tab. UI shows "Opened in X". */
  | 'handed_off';

/**
 * Mirror of `PlanItemState` from the SM. We don't import the worker-side
 * type here so the hook stays free of server-only deps; the only values
 * the UI actually distinguishes are `'drafted'`, `'ready_for_review'`, and
 * `'approved'` (the three states the Today feed surfaces).
 */
export type PlanState =
  | 'planned'
  | 'drafted'
  | 'ready_for_review'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'superseded'
  | 'stale';

export interface TodoItem {
  id: string;
  draftId: string | null;
  todoType: 'approve_post' | 'reply_thread' | 'respond_engagement';
  source: 'calendar' | 'discovery' | 'engagement';
  priority: 'time_sensitive' | 'scheduled' | 'optional';
  status: TodoOptimisticStatus;
  /** plan_items.state for calendar rows; null for reply drafts. */
  planState: PlanState | null;
  /** When `status === 'queued'`, ms until the BullMQ job fires (best-effort). */
  queuedDelayMs?: number;
  /**
   * Pre-built X compose intent URL. Non-null only for X drafts (replies and
   * original posts). When set, the card uses browser handoff instead of the
   * API/queue path: clicking opens X compose pre-filled, the card stays in
   * Today until the user Skips it.
   */
  xIntentUrl: string | null;
  title: string;
  platform: string;
  community: string | null;
  externalUrl: string | null;
  confidence: number | null;
  scheduledFor: string | null;
  expiresAt: string;
  createdAt: string;
  // Joined from draft
  draftBody: string | null;
  draftConfidence: number | null;
  draftWhyItWorks: string | null;
  draftType: 'reply' | 'original_post' | null;
  draftPostTitle: string | null;
  draftMedia: Array<{ url: string; type: 'image' | 'gif' | 'video'; alt?: string }> | null;
  // Joined from thread (original content being replied to)
  threadTitle: string | null;
  threadBody: string | null;
  threadAuthor: string | null;
  threadUrl: string | null;
  threadUpvotes: number | null;
  threadCommentCount: number | null;
  threadPostedAt: string | null;
  threadDiscoveredAt: string | null;
  // Discovery conversational rewrite (2026-04-26): engagement signal +
  // repost canonicalization joined from threads.
  threadLikesCount: number | null;
  threadRepostsCount: number | null;
  threadRepliesCount: number | null;
  threadViewsCount: number | null;
  threadIsRepost: boolean;
  threadOriginalUrl: string | null;
  threadOriginalAuthorUsername: string | null;
  threadSurfacedVia: string[] | null;
  // Joined from calendar
  calendarContentType: string | null;
  calendarScheduledAt: string | null;
  // Derived
  cardFormat: 'post' | 'reply';
}

export interface TodayStats {
  published_yesterday: number;
  pending_count: number;
  acted_today: number;
}

type RawTodoItem = Omit<TodoItem, 'cardFormat'>;

function deriveCardFormat(item: RawTodoItem): 'post' | 'reply' {
  if (item.draftType === 'original_post') return 'post';
  if (item.draftType === 'reply') return 'reply';
  // Fallback when no draft is linked: honor the plan_item's `kind`
  // (surfaced as `calendarContentType`). Without this, every
  // content_reply plan_item without a drafted body was being classed
  // as 'post' and shown in the Scheduled posts section with a
  // placeholder title — even though the underlying slot is a reply.
  if (item.calendarContentType === 'content_reply') return 'reply';
  return item.source === 'calendar' ? 'post' : 'reply';
}

/**
 * Daily reply-slot progress row (one per `content_reply` plan_item
 * scheduled for today). Surfaced separately from the post + reply
 * cards so the UI can render a single "Today's reply session: Y of N
 * drafted" progress card per channel — rather than showing N empty
 * placeholder cards before the daily cron has filled them.
 */
export interface ReplySlot {
  id: string;
  channel: string;
  scheduledAt: string;
  targetCount: number;
  draftedToday: number;
  state: 'planned' | 'drafted' | 'completed';
}

interface TodayResponse {
  items: RawTodoItem[];
  stats: TodayStats;
  /** Today's reply-slot progress rows. Always present in the response;
   *  empty array when the user has no `content_reply` slots scheduled
   *  for today (channelMix.x.repliesPerDay is null/0/omitted). */
  replySlots?: ReplySlot[];
  /** True iff the user has at least one plan_items row (any state). Drives
   *  the Today-level FirstRun gate — distinguishes "no plan yet" from
   *  "plan exists, everything handled today". */
  hasAnyPlanItems?: boolean;
}

export function useToday() {
  const { data, error, isLoading, mutate } = useSWR<TodayResponse>(
    '/api/today',
    fetcher,
    { refreshInterval: 30_000 },
  );

  // Merge-by-id updater factory: produces a new TodayResponse where the
  // targeted item is stamped with an optimistic status flag (instead of
  // being removed). Keeps the list order stable so the card doesn't jump
  // out from under the user while the request is in flight.
  const markPending = useCallback(
    (id: string, status: TodoOptimisticStatus, queuedDelayMs?: number) =>
      (prev: TodayResponse | undefined): TodayResponse | undefined => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((i) =>
            i.id === id ? { ...i, status, queuedDelayMs } : i,
          ),
        };
      },
    [],
  );

  const approve = useCallback(
    async (id: string) => {
      // Capture pre-mutation snapshot so we can roll back on failure
      // without triggering a full revalidate round-trip.
      const snapshot = data;

      mutate(markPending(id, 'pending_approval'), { revalidate: false });
      try {
        const res = await fetch(`/api/today/${id}/approve`, { method: 'PATCH' });
        let body: ApproveResponseBody = {};
        try {
          body = (await res.json()) as ApproveResponseBody;
        } catch {
          // Non-JSON response — leave body empty.
        }

        // 202 deferred: pacer pushed the post to a later slot. Restore the
        // card and surface a terse toast so the user knows what happened.
        if (res.status === 202 && body.deferred) {
          mutate(snapshot, { revalidate: false });
          throw new TodayActionError(
            formatDeferredMessage(body.reason ?? 'pacer', body.retryAfterMs ?? 0),
            'deferred',
            undefined,
            202,
          );
        }

        if (!res.ok) {
          mutate(snapshot, { revalidate: false });
          throw new TodayActionError(
            body.error ?? `Request failed (${res.status})`,
            body.code,
            body.platform,
            res.status,
          );
        }

        // X reply handoff: pop the X compose tab pre-filled, then mark the
        // card as 'handed_off' so the UI swaps the button to "Opened in X".
        // The server has already set drafts.status='handed_off' so the next
        // revalidate drops it from the feed entirely.
        if (body.browserHandoff?.intentUrl) {
          if (typeof window !== 'undefined') {
            window.open(body.browserHandoff.intentUrl, '_blank', 'noopener,noreferrer');
          }
          mutate(markPending(id, 'handed_off'), { revalidate: false });
          // Skip the trailing mutate() — keep the optimistic state until
          // the next polling tick (refreshInterval: 30s) picks up the
          // server-side feed exclusion.
          return;
        }

        // Queued: server confirmed the post is in BullMQ. Mark the card
        // 'queued' so the button swaps to "Post now" + ETA.
        if (body.queued) {
          mutate(markPending(id, 'queued', body.queued.delayMs), {
            revalidate: false,
          });
          return;
        }
      } catch (err) {
        // For non-deferred errors restore state; deferred path already did so.
        if (!(err instanceof TodayActionError && err.code === 'deferred')) {
          mutate(snapshot, { revalidate: false });
        }
        throw err;
      }
      mutate();
    },
    [data, markPending, mutate],
  );

  /**
   * "Post now" — re-enqueue an already-approved draft with delayMs=0,
   * bypassing the pacer's spacing/quiet-hours delay. Server keeps the
   * worker idempotent (draft.status check) so even if the original
   * delayed job later fires, it aborts cleanly.
   */
  const postNow = useCallback(
    async (id: string) => {
      const snapshot = data;
      mutate(markPending(id, 'pending_approval'), { revalidate: false });
      try {
        const res = await fetch(`/api/today/${id}/post-now`, { method: 'POST' });
        let body: { error?: string; code?: string } = {};
        try {
          body = await res.json();
        } catch {
          // ignore non-JSON
        }
        if (!res.ok) {
          mutate(snapshot, { revalidate: false });
          throw new TodayActionError(
            body.error ?? `Request failed (${res.status})`,
            body.code,
            undefined,
            res.status,
          );
        }
      } catch (err) {
        mutate(snapshot, { revalidate: false });
        throw err;
      }
      mutate();
    },
    [data, markPending, mutate],
  );

  const skip = useCallback(
    async (id: string) => {
      const snapshot = data;

      mutate(markPending(id, 'pending_skip'), { revalidate: false });
      try {
        await postJson(`/api/today/${id}/skip`, { method: 'PATCH' });
      } catch (err) {
        mutate(snapshot, { revalidate: false });
        throw err;
      }
      mutate();
    },
    [data, markPending, mutate],
  );

  const edit = useCallback(
    async (id: string, body: string) => {
      try {
        await postJson(`/api/today/${id}/edit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
      } finally {
        mutate();
      }
    },
    [mutate],
  );

  const reschedule = useCallback(
    async (id: string, scheduledFor: string) => {
      const snapshot = data;

      mutate(markPending(id, 'pending_reschedule'), { revalidate: false });
      try {
        await postJson(`/api/today/${id}/reschedule`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledFor }),
        });
      } catch (err) {
        mutate(snapshot, { revalidate: false });
        throw err;
      }
      mutate();
    },
    [data, markPending, mutate],
  );

  const items: TodoItem[] = (data?.items ?? []).map((item) => ({
    ...item,
    cardFormat: deriveCardFormat(item),
  }));

  return {
    items,
    replySlots: data?.replySlots ?? [],
    stats: data?.stats ?? { published_yesterday: 0, pending_count: 0, acted_today: 0 },
    // Fall back to items.length > 0 before the first hydration so the
    // hook stays honest when /api/today responds without the flag (e.g.
    // during backend rollouts that predate the field).
    hasAnyPlanItems:
      typeof data?.hasAnyPlanItems === 'boolean'
        ? data.hasAnyPlanItems
        : items.length > 0,
    isLoading,
    error,
    approve,
    postNow,
    skip,
    edit,
    reschedule,
    mutate,
  };
}
