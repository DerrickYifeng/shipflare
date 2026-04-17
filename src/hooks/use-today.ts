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

export interface TodoItem {
  id: string;
  draftId: string | null;
  todoType: 'approve_post' | 'reply_thread' | 'respond_engagement';
  source: 'calendar' | 'discovery' | 'engagement';
  priority: 'time_sensitive' | 'scheduled' | 'optional';
  status: 'pending';
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
}

export function useToday() {
  const { data, error, isLoading, mutate } = useSWR<TodayResponse>(
    '/api/today',
    fetcher,
    { refreshInterval: 30_000 },
  );

  const approve = useCallback(
    async (id: string) => {
      // Optimistic hide.
      mutate(
        (prev) =>
          prev
            ? { ...prev, items: prev.items.filter((i) => i.id !== id) }
            : prev,
        false,
      );
      try {
        await postJson(`/api/today/${id}/approve`, { method: 'PATCH' });
      } catch (err) {
        // Roll back the optimistic hide so the user can retry once they've
        // fixed the underlying cause (e.g. connected their X account).
        await mutate();
        throw err;
      }
      mutate();
    },
    [mutate],
  );

  const skip = useCallback(
    async (id: string) => {
      mutate(
        (prev) =>
          prev
            ? { ...prev, items: prev.items.filter((i) => i.id !== id) }
            : prev,
        false,
      );
      try {
        await postJson(`/api/today/${id}/skip`, { method: 'PATCH' });
      } catch (err) {
        await mutate();
        throw err;
      }
      mutate();
    },
    [mutate],
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
      mutate(
        (prev) =>
          prev
            ? { ...prev, items: prev.items.filter((i) => i.id !== id) }
            : prev,
        false,
      );
      try {
        await postJson(`/api/today/${id}/reschedule`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledFor }),
        });
      } catch (err) {
        await mutate();
        throw err;
      }
      mutate();
    },
    [mutate],
  );

  const items: TodoItem[] = (data?.items ?? []).map((item) => ({
    ...item,
    cardFormat: deriveCardFormat(item),
  }));

  return {
    items,
    stats: data?.stats ?? { published_yesterday: 0, pending_count: 0, acted_today: 0 },
    isLoading,
    error,
    approve,
    skip,
    edit,
    reschedule,
    mutate,
  };
}
