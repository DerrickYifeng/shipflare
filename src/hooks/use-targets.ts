'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface TargetAccount {
  id: string;
  username: string;
  displayName: string | null;
  xUserId: string | null;
  followerCount: number | null;
  priority: number;
  category: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

export function useTargets() {
  const { data, error, isLoading, mutate } = useSWR<{ targets: TargetAccount[] }>(
    '/api/x/targets',
    fetcher,
    { refreshInterval: 60_000 },
  );

  const addTarget = useCallback(
    async (username: string, category?: string, priority?: number) => {
      const res = await fetch('/api/x/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, category, priority }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to add target');
      }

      mutate();
    },
    [mutate],
  );

  const removeTarget = useCallback(
    async (targetId: string) => {
      mutate(
        (prev) =>
          prev
            ? { targets: prev.targets.filter((t) => t.id !== targetId) }
            : prev,
        false,
      );

      const res = await fetch('/api/x/targets', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to remove target');
      }

      mutate();
    },
    [mutate],
  );

  return {
    targets: data?.targets?.filter((t) => t.isActive) ?? [],
    isLoading,
    error,
    addTarget,
    removeTarget,
    mutate,
  };
}
