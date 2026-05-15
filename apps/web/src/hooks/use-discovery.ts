'use client';

import useSWR from 'swr';

import { fetcher } from '@/lib/fetcher';

interface DiscoveredThread {
  id: string;
  externalId: string;
  /** NULL for X threads (no Reddit-style subreddit equivalent). */
  community: string | null;
  title: string;
  url: string;
  relevanceScore: number;
  createdAt: string;
}

export function useDiscovery() {
  const { data, error, isLoading } = useSWR<{ threads: DiscoveredThread[] }>(
    '/api/discovery',
    fetcher,
    { refreshInterval: 60_000 },
  );

  return {
    threads: data?.threads ?? [],
    isLoading,
    error,
  };
}
