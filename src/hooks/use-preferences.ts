'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to save preferences');
      }

      const result = await res.json();
      mutate(result, false);
      return result.preferences as Preferences;
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
