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
  | 'pending_reschedule';

export interface TodoItem {
  id: string;
  draftId: string | null;
  todoType: 'approve_post' | 'reply_thread' | 'respond_engagement';
  source: 'calendar' | 'discovery' | 'engagement';
  priority: 'time_sensitive' | 'scheduled' | 'optional';
  status: TodoOptimisticStatus;
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
  // Fallback when no draft is linked
  return item.source === 'calendar' ? 'post' : 'reply';
}

interface TodayResponse {
  items: RawTodoItem[];
  stats: TodayStats;
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
        await postJson(`/api/today/${id}/approve`, { method: 'PATCH' });
      } catch (err) {
        // Restore the exact state the user saw before the click.
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
    reschedule,
    mutate,
  };
}
