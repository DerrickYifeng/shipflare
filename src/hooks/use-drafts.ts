'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface Draft {
  id: string;
  threadId: string;
  replyBody: string;
  confidenceScore: number;
  whyItWorks: string;
  ftcDisclosure: string;
  status: string;
  createdAt: string;
  thread: {
    title: string;
    subreddit: string;
    url: string;
  };
}

export function useDrafts() {
  const { data, error, isLoading, mutate } = useSWR<{ drafts: Draft[] }>(
    '/api/drafts',
    fetcher,
    { refreshInterval: 30_000 },
  );

  const approve = useCallback(
    async (draftId: string) => {
      // Optimistic update
      mutate(
        (prev) =>
          prev
            ? {
                drafts: prev.drafts.filter((d) => d.id !== draftId),
              }
            : prev,
        false,
      );

      await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, action: 'approve' }),
      });

      mutate();
    },
    [mutate],
  );

  const skip = useCallback(
    async (draftId: string) => {
      mutate(
        (prev) =>
          prev
            ? {
                drafts: prev.drafts.filter((d) => d.id !== draftId),
              }
            : prev,
        false,
      );

      await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, action: 'skip' }),
      });

      mutate();
    },
    [mutate],
  );

  return {
    drafts: data?.drafts ?? [],
    isLoading,
    error,
    approve,
    skip,
    mutate,
  };
}
