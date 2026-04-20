import type { ReactNode } from 'react';
import { AgentStreamProvider } from '@/hooks/agent-stream-provider';

/**
 * `/team` is now the only route that needs the live agent SSE stream.
 * Mounting the provider at the route-layout level (instead of the app-wide
 * layout) keeps the EventSource connection off Today / Growth / Calendar /
 * Settings — those pages don't care about agent events and would otherwise
 * hold an open HTTP stream open for no reason.
 *
 * See audit synthesis Theme 7 and the previous `/automation/layout.tsx`
 * that this file replaces.
 */
export default function TeamLayout({ children }: { children: ReactNode }) {
  return <AgentStreamProvider>{children}</AgentStreamProvider>;
}
