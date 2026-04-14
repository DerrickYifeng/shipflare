'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface MonitoredTweet {
  id: string;
  tweetId: string;
  tweetText: string;
  authorUsername: string;
  tweetUrl: string;
  postedAt: string;
  discoveredAt: string;
  replyDeadline: string;
  status: string;
  targetUsername: string;
  targetDisplayName: string | null;
  targetCategory: string | null;
}

export function useMonitoredTweets() {
  const { data, error, isLoading, mutate } = useSWR<{ tweets: MonitoredTweet[] }>(
    '/api/x/monitor',
    fetcher,
    { refreshInterval: 15_000 },
  );

  const triggerScan = useCallback(async () => {
    const res = await fetch('/api/x/monitor', { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Failed to trigger scan');
    }
    mutate();
  }, [mutate]);

  return {
    tweets: data?.tweets ?? [],
    isLoading,
    error,
    triggerScan,
    mutate,
  };
}
