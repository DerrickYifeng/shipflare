import type { ReactNode } from 'react';
import { AgentStreamProvider } from '@/hooks/agent-stream-provider';

/**
 * `/automation/*` is the only area that cares about the live agent SSE
 * stream. Mounting the provider here (instead of `(app)/layout.tsx`) keeps the
 * EventSource connection off the other routes (today, calendar, analytics...)
 * so they don't pay the cost of an always-open HTTP stream + toast handler.
 *
 * Audit: FE P0-2 ("AgentStreamProvider 全局订阅 SSE，但 90% 页面用不到") —
 * see `audit/audit-synthesis.md` lines 160-178 (Wave 3 Theme 7).
 */
export default function AutomationLayout({ children }: { children: ReactNode }) {
  return <AgentStreamProvider>{children}</AgentStreamProvider>;
}
