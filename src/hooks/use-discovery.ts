'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface DiscoveredThread {
  id: string;
  externalId: string;
  community: string;
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
