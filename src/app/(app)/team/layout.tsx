import type { ReactNode } from 'react';

/**
 * `/team` — Phase D scaffold. Day 1 is a read-only server-rendered view;
 * Day 2 adds the SSE hook (`useTeamEvents`) that subscribes to
 * `/api/team/events` on the client. No route-level provider needed yet.
 */
export default function TeamLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
