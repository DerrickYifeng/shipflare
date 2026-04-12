'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface HealthScore {
  score: number;
  s1Pipeline: number;
  s2Quality: number;
  s3Engagement: number;
  s4Consistency: number;
  s5Safety: number;
  createdAt: string;
}

export function useHealthScore() {
  const { data, error, isLoading } = useSWR<{ healthScore: HealthScore | null }>(
    '/api/health',
    fetcher,
    { refreshInterval: 120_000 },
  );

  return {
    healthScore: data?.healthScore ?? null,
    isLoading,
    error,
  };
}
