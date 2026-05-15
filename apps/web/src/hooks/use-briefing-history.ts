'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
// TODO Task 2.5: replace inline type with import from '@/app/api/briefing/history/route' once route is ported
import type { TodoItem } from '@/hooks/use-today';

interface TodoMedia {
  url: string;
  type: 'image' | 'gif' | 'video';
}

interface BriefingHistoryItem {
  id: string;
  draftId: string;
  todoType: 'reply_thread';
  source: 'discovery';
  priority: 'time_sensitive';
  status: 'handed_off' | 'posted';
  planState: null;
  xIntentUrl: string | null;
  title: string;
  platform: string;
  community: string | null;
  externalUrl: string | null;
  confidence: number | null;
  expiresAt: string;
  createdAt: string;
  draftBody: string | null;
  draftConfidence: number | null;
  draftWhyItWorks: string | null;
  draftType: 'reply' | 'original_post';
  draftPostTitle: string | null;
  draftMedia: TodoMedia[] | null;
  threadTitle: string | null;
  threadBody: string | null;
  threadAuthor: string | null;
  threadUrl: string | null;
  threadUpvotes: number | null;
  threadCommentCount: number | null;
  threadPostedAt: string | null;
  threadDiscoveredAt: string | null;
  threadLikesCount: number | null;
  threadRepostsCount: number | null;
  params: null;
  cardFormat: 'post' | 'reply';
}

interface BriefingHistoryResponse {
  items: BriefingHistoryItem[];
  windowDays: number;
}

const fetcher = async (url: string): Promise<BriefingHistoryResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load briefing history (${res.status})`);
  }
  return (await res.json()) as BriefingHistoryResponse;
};

export interface UseBriefingHistoryResult {
  items: TodoItem[];
  windowDays: number;
  isLoading: boolean;
  error: unknown;
  refresh: () => void;
}

/** Map a server-side history item into the same TodoItem shape the
 *  Today feed renders, so <ReplyCard /> can consume both without
 *  branching on the data source. */
function adapt(item: BriefingHistoryItem): TodoItem {
  return {
    ...item,
    // History rows are all reply drafts (no plan_items.params), so
    // there's no subreddit picker to surface. Stamp `null` to satisfy
    // the TodoItem contract added in Task 9 of the Reddit subreddit
    // research work.
    params: null,
    cardFormat: item.draftType === 'original_post' ? 'post' : 'reply',
    // Fields added to TodoItem after BriefingHistoryItem was defined —
    // history rows don't carry these engagement/repost fields.
    threadRepliesCount: null,
    threadViewsCount: null,
    threadIsRepost: false,
    threadOriginalUrl: null,
    threadOriginalAuthorUsername: null,
    threadSurfacedVia: null,
    calendarContentType: null,
    // BriefingHistoryItem.status is a subset of TodoOptimisticStatus;
    // the cast is safe since only 'handed_off'|'posted' are used here.
  };
}

export function useBriefingHistory(): UseBriefingHistoryResult {
  const { data, error, isLoading, mutate } = useSWR<BriefingHistoryResponse>(
    '/api/briefing/history',
    fetcher,
    { refreshInterval: 60_000 },
  );
  const items = useMemo<TodoItem[]>(
    () => (data?.items ?? []).map(adapt),
    [data],
  );
  return {
    items,
    windowDays: data?.windowDays ?? 7,
    isLoading,
    error,
    refresh: () => void mutate(),
  };
}
