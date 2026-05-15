'use client';

import useSWR from 'swr';

import { fetcher } from '@/lib/fetcher';

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
