'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import type { BriefingHistoryItem } from '@/app/api/briefing/history/route';
import type { TodoItem } from '@/hooks/use-today';

interface BriefingHistoryResponse {
  items: BriefingHistoryItem[];
  windowDays: number;
}

const fetcher = async (url: string): Promise<BriefingHistoryResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load briefing history (${res.status})`);
  }
  return (await res.json()) as BriefingHistoryResponse;
};

export interface UseBriefingHistoryResult {
  items: TodoItem[];
  windowDays: number;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
}

/** Map a server-side history item into the same TodoItem shape the
 *  Today feed renders, so <ReplyCard /> can consume both without
 *  branching on the data source. */
function adapt(item: BriefingHistoryItem): TodoItem {
  return {
    ...item,
    cardFormat: item.draftType === 'original_post' ? 'post' : 'reply',
  };
}

export function useBriefingHistory(): UseBriefingHistoryResult {
  const { data, error, isLoading, mutate } = useSWR<BriefingHistoryResponse>(
    '/api/briefing/history',
    fetcher,
    { refreshInterval: 60_000 },
  );
  const items = useMemo<TodoItem[]>(
    () => (data?.items ?? []).map(adapt),
    [data],
  );
  return {
    items,
    windowDays: data?.windowDays ?? 7,
    isLoading,
    error,
    refresh: () => void mutate(),
  };
}
