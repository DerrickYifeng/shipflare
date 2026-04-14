'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
