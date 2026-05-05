'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';
import type { BriefingSummary } from '@/app/api/briefing/summary/route';
import { BriefingHeader } from './briefing-header';
import { TabNav } from './tab-nav';

const fetcher = async (url: string): Promise<BriefingSummary | null> => {
  const r = await fetch(url);
  if (!r.ok) return null;
  return (await r.json()) as BriefingSummary;
};

export function BriefingShell({ children }: { children: ReactNode }) {
  const { data } = useSWR<BriefingSummary | null>(
    '/api/briefing/summary',
    fetcher,
    { refreshInterval: 60_000 },
  );
  return (
    <>
      <BriefingHeader summary={data ?? null} />
      <TabNav />
      {children}
    </>
  );
}
