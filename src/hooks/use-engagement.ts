'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface EngagementDraft {
  id: string;
  replyBody: string;
  confidenceScore: number;
  status: string;
  createdAt: string;
  thread: {
    title: string;
    community: string;
    url: string;
  };
}

export interface RecentXPost {
  id: string;
  externalId: string;
  externalUrl: string | null;
  community: string;
  status: string;
  postedAt: string;
}

export function useEngagement() {
  const { data, error, isLoading, mutate } = useSWR<{
    recentPosts: RecentXPost[];
    engagementDrafts: EngagementDraft[];
  }>('/api/x/engagement', fetcher, { refreshInterval: 30_000 });

  return {
    recentPosts: data?.recentPosts ?? [],
    engagementDrafts: data?.engagementDrafts ?? [],
    isLoading,
    error,
    mutate,
  };
}
