'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

import { fetcher } from '@/lib/fetcher';

export type Theme = 'light' | 'dark';

export interface Preferences {
  timezone: string;
  theme: Theme;
}

export function usePreferences() {
  const { data, error, isLoading, mutate } = useSWR<Preferences>(
    '/api/preferences',
    fetcher,
  );

  const update = useCallback(
    async (patch: Partial<Preferences>) => {
      const res = await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        const bodyTyped = body as { error?: string };
        throw new Error(bodyTyped.error ?? 'Failed to save preferences');
      }

      const next = await res.json() as Preferences;
      mutate(next, false);
      return next;
    },
    [mutate],
  );

  return {
    preferences: data ?? null,
    isLoading,
    error,
    update,
    mutate,
  };
}
