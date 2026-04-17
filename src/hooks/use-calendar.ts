'use client';

import useSWR, { mutate as globalMutate } from 'swr';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSSEChannel } from './use-sse-channel';
import { useProgressiveStream } from './use-progressive-stream';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface CalendarItemMetrics {
  likes: number;
  replies: number;
  bookmarks: number;
}

export interface CalendarItem {
  id: string;
  channel: string;
  scheduledAt: string;
  contentType: string;
  status: string;
  topic: string | null;
  draftId: string | null;
  draftPreview: string | null;
  postedExternalId: string | null;
  createdAt: string;
  /** Present when the linked draft has status='posted'. */
  postUrl: string | null;
  /** Latest x_tweet_metrics sample, if any. */
  metrics: CalendarItemMetrics | null;
}

export function useCalendar(
  range: '7d' | '14d' | '30d' = '7d',
  channel: string = 'all',
) {
  const { data, error, isLoading, mutate } = useSWR<{ items: CalendarItem[] }>(
    `/api/calendar?range=${range}&channel=${channel}`,
    fetcher,
    // SSE drives fresh data; 60s poll is a safety-net.
    { refreshInterval: 60_000 },
  );

  const [isGenerating, setIsGenerating] = useState(false);

  // Progressive-stream view of plan pipeline events — a per-slot snapshot
  // map driven by the unified `pipeline` envelope. Used to hydrate card
  // state as it streams in, independent of SWR's cache revalidation.
  const plan = useProgressiveStream<{
    scheduledAt?: string;
    contentType?: string;
    topic?: string;
    draftId?: string;
    previewBody?: string;
    reason?: string;
  }>('plan');

  // Listen for calendar-related SSE events to refresh data in real-time.
  // Publishers emit the unified `pipeline` envelope per slot and a single
  // `plan_shell_ready` when the plan has been committed to the DB.
  useSSEChannel('agents', (raw) => {
    const event = raw as { type?: string; pipeline?: string };
    if (event.type === 'plan_shell_ready') {
      setIsGenerating(false);
      void mutate();
      return;
    }
    if (event.type === 'pipeline' && event.pipeline === 'plan') {
      void mutate();
      return;
    }
    if (event.type === 'calendar_plan_failed') {
      setIsGenerating(false);
      void mutate();
    }
  });

  // Safety: clear isGenerating after 120s even if SSE never fires
  useEffect(() => {
    if (!isGenerating) return;
    const timer = setTimeout(() => setIsGenerating(false), 120_000);
    return () => clearTimeout(timer);
  }, [isGenerating]);

  const generateWeek = useCallback(
    async (forChannel: string = 'x', topics?: string[]) => {
      setIsGenerating(true);

      const res = await fetch('/api/calendar/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: forChannel, topics }),
      });

      if (!res.ok) {
        setIsGenerating(false);
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to generate calendar');
      }

      // API returns 202 immediately. SSE will notify when the plan is ready.
      // Keep safety-net polls for the Today page.
      setTimeout(() => globalMutate('/api/today'), 30_000);
      setTimeout(() => globalMutate('/api/today'), 120_000);
    },
    [],
  );

  const cancelItem = useCallback(
    async (itemId: string) => {
      mutate(
        (prev) =>
          prev
            ? { items: prev.items.filter((i) => i.id !== itemId) }
            : prev,
        false,
      );

      const res = await fetch('/api/calendar', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to cancel item');
      }

      mutate();
    },
    [mutate],
  );

  // Merge live progressive-stream state into each item. The server-rendered
  // `status` is authoritative once persisted; live state is a fast-path that
  // flips the card into `drafting` / `draft_created` / `failed` before the
  // next SWR revalidation completes.
  const baseItems = data?.items ?? [];
  const mergedItems = useMemo(() => {
    if (plan.items.size === 0) return baseItems;
    return baseItems.map((item) => {
      const live = plan.items.get(item.id);
      if (!live) return item;
      const mappedStatus =
        live.state === 'ready'
          ? 'draft_created'
          : live.state === 'failed'
            ? 'failed'
            : live.state === 'drafting'
              ? 'drafting'
              : item.status;
      return {
        ...item,
        status: mappedStatus,
        draftPreview: live.data?.previewBody ?? item.draftPreview,
      };
    });
  }, [baseItems, plan.items]);

  return {
    items: mergedItems,
    isLoading,
    error,
    generateWeek,
    cancelItem,
    mutate,
    isGenerating,
    plan,
  };
}
