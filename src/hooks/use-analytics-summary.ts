'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ContentTypePerf {
  type: string;
  avgBookmarks: number;
  avgImpressions: number;
  count: number;
}

interface PostingHourPerf {
  hour: number;
  avgEngagement: number;
}

export interface AnalyticsSummary {
  periodStart: string;
  periodEnd: string;
  bestContentTypes: ContentTypePerf[];
  bestPostingHours: PostingHourPerf[];
  audienceGrowthRate: number;
  engagementRate: number;
  totalImpressions: number;
  totalBookmarks: number;
  computedAt: string;
}

export function useAnalyticsSummary() {
  const { data, error, isLoading } = useSWR<{ summary: AnalyticsSummary | null }>(
    '/api/x/analytics-summary',
    fetcher,
  );

  return {
    summary: data?.summary ?? null,
    isLoading,
    error,
  };
}
