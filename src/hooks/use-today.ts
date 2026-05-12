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
  queued?: boolean;
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
  | 'queued'
  | 'handed_off'
  | 'posted';

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
  dueDate: string;
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
    (id: string, status: TodoOptimisticStatus) =>
      (prev: TodayResponse | undefined): TodayResponse | undefined => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((i) =>
            i.id === id ? { ...i, status } : i,
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

        // Queued: server confirmed the post is in BullMQ. Mark optimistically
        // so the card shows "Posted ✓" instead of the Post button, then poll
        // again in ~3s + 8s — the posting worker typically flips the plan_item
        // to `completed` within seconds, at which point /api/today drops the
        // row from the feed and the card disappears.
        if (body.queued) {
          mutate(markPending(id, 'queued'), { revalidate: false });
          window.setTimeout(() => {
            void mutate();
          }, 3000);
          window.setTimeout(() => {
            void mutate();
          }, 8000);
          return;
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

  /**
   * Path B handoff: the user clicked the X-intent button in the card,
   * which already opened the compose tab synchronously inside the click
   * handler. We just need to record that on the server so the next feed
   * poll moves the card from Briefing → History.
   *
   * Fire-and-forget by design — the window has already opened; if the
   * /approve POST drops we'll record on the next user click or skip
   * surfacing the move silently. We optimistically flip the local status
   * so the dim/disable styling kicks in immediately, then a 30s poll
   * picks up the server's `handed_off` and the row leaves the feed.
   */
  const handoff = useCallback(
    (id: string) => {
      mutate(markPending(id, 'handed_off'), { revalidate: false });
      void fetch(`/api/today/${id}/approve`, { method: 'PATCH' }).catch(() => {
        // Swallow — the poll-based reconciliation will catch up next tick.
      });
    },
    [markPending, mutate],
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
    skip,
    edit,
    handoff,
    mutate,
  };
}
