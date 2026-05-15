'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as T);

export interface Preferences {
  autoApproveEnabled: boolean;
  autoApproveThreshold: number;
  autoApproveTypes: string[];
  maxAutoApprovalsPerDay: number;
  postingHoursUtc: number[];
  contentMixMetric: number;
  contentMixEducational: number;
  contentMixEngagement: number;
  contentMixProduct: number;
  notifyOnNewDraft: boolean;
  notifyOnAutoApprove: boolean;
  timezone: string;
}

export function usePreferences() {
  const { data, error, isLoading, mutate } = useSWR<{ preferences: Preferences }>(
    '/api/preferences',
    fetcher,
  );

  const update = useCallback(
    async (patch: Partial<Preferences>) => {
      const res = await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        const bodyTyped = body as { error?: string };
        throw new Error(bodyTyped.error ?? 'Failed to save preferences');
      }

      const result = await res.json() as { preferences: Preferences };
      mutate(result, false);
      return result.preferences;
    },
    [mutate],
  );

  return {
    preferences: data?.preferences ?? null,
    isLoading,
    error,
    update,
    mutate,
  };
}
