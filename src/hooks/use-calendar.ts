'use client';

import useSWR, { mutate as globalMutate } from 'swr';
import { useCallback } from 'react';

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
    { refreshInterval: 60_000 },
  );

  const generateWeek = useCallback(
    async (forChannel: string = 'x', topics?: string[]) => {
      const res = await fetch('/api/calendar/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: forChannel, topics }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to generate calendar');
      }

      mutate();

      // Progressive Today page refresh as pipeline jobs complete
      setTimeout(() => globalMutate('/api/today'), 5_000);
      setTimeout(() => globalMutate('/api/today'), 30_000);
      setTimeout(() => globalMutate('/api/today'), 120_000);

      return res.json();
    },
    [mutate],
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

  return {
    items: data?.items ?? [],
    isLoading,
    error,
    generateWeek,
    cancelItem,
    mutate,
  };
}
