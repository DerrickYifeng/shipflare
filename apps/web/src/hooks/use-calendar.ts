'use client';

import useSWR from 'swr';

import { fetcher } from '@/lib/fetcher';

export interface CalendarItem {
  id: string;
  kind: string;
  state: string;
  channel: string | null;
  dueDate: string;
  sortOrder: number;
  title: string;
  description: string | null;
  phase: string;
}

export interface CalendarDay {
  date: string;
  items: CalendarItem[];
}

export interface CalendarResponse {
  weekStart: string;
  weekEnd: string;
  prev: string;
  next: string;
  days: CalendarDay[];
  totals: {
    scheduled: number;
    completed: number;
    skipped: number;
  };
}

export function useCalendar(weekStart?: string) {
  const key = weekStart
    ? `/api/calendar?weekStart=${encodeURIComponent(weekStart)}`
    : '/api/calendar';

  const { data, error, isLoading, mutate } = useSWR<CalendarResponse>(
    key,
    fetcher,
    { refreshInterval: 60_000 },
  );

  return {
    data,
    days: data?.days ?? [],
    totals: data?.totals ?? { scheduled: 0, completed: 0, skipped: 0 },
    weekStart: data?.weekStart,
    weekEnd: data?.weekEnd,
    prev: data?.prev,
    next: data?.next,
    isLoading,
    error,
    mutate,
  };
}
