'use client';

import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface PipelineStatus {
  name: string;
  status: 'healthy' | 'warning' | 'error';
  lastRun: string | null;
  nextRun: string | null;
  cronDescription: string;
  errorCount: number;
}

interface AutomationStatus {
  pipelines: PipelineStatus[];
  drafts: {
    pending: number;
    approved: number;
    posted: number;
  };
}

export function useAutomationStatus() {
  const { data, error, isLoading } = useSWR<AutomationStatus>(
    '/api/automation/status',
    fetcher,
    { refreshInterval: 60_000 },
  );

  return {
    pipelines: data?.pipelines ?? [],
    draftCounts: data?.drafts ?? { pending: 0, approved: 0, posted: 0 },
    isLoading,
    error,
  };
}
