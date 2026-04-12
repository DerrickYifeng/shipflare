'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ActivityEvent {
  id: string;
  eventType: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}

export function useActivity() {
  const { data, error, isLoading } = useSWR<{ events: ActivityEvent[] }>(
    '/api/activity',
    fetcher,
    { refreshInterval: 30_000 },
  );

  return {
    events: data?.events ?? [],
    isLoading,
    error,
  };
}
