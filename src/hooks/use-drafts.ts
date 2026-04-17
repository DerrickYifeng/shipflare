'use client';

import useSWR from 'swr';
import { useCallback } from 'react';
import { useSSEChannel } from './use-sse-channel';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface DraftReview {
  verdict: string;
  score: number;
  checks?: Array<{ name: string; result: string; detail: string }>;
  issues?: string[];
  suggestions?: string[];
}

export type DraftSource = 'monitor' | 'calendar' | 'engagement' | 'discovery';
export type DraftUrgency = 'critical' | 'high' | 'normal';

export interface Draft {
  id: string;
  threadId: string;
  draftType: string;
  postTitle: string | null;
  replyBody: string;
  confidenceScore: number;
  whyItWorks: string;
  ftcDisclosure: string;
  status: string;
  source: DraftSource;
  urgency: DraftUrgency;
  platform: string;
  replyDeadline: string | null;
  review: DraftReview | null;
  createdAt: string;
  thread: {
    title: string;
    community: string;
    url: string;
  };
}

export function useDrafts() {
  const { data, error, isLoading, mutate } = useSWR<{ drafts: Draft[] }>(
    '/api/drafts',
    fetcher,
    // SSE drives fresh data (see `useSSEChannel` below). The 60s poll is a
    // safety-net in case the pub/sub stream is unhealthy.
    { refreshInterval: 60_000 },
  );

  useSSEChannel('drafts', () => {
    void mutate();
  });

  const performAction = useCallback(
    async (draftId: string, action: string) => {
      mutate(
        (prev) =>
          prev
            ? { drafts: prev.drafts.filter((d) => d.id !== draftId) }
            : prev,
        false,
      );

      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, action }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Action failed');
      }

      mutate();
    },
    [mutate],
  );

  const approve = useCallback(
    (draftId: string) => performAction(draftId, 'approve'),
    [performAction],
  );

  const skip = useCallback(
    (draftId: string) => performAction(draftId, 'skip'),
    [performAction],
  );

  const retry = useCallback(
    (draftId: string) => performAction(draftId, 'retry'),
    [performAction],
  );

  return {
    drafts: data?.drafts ?? [],
    isLoading,
    error,
    approve,
    skip,
    retry,
    mutate,
  };
}
