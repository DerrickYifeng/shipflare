'use client';

import { AgentGrid } from '@/components/dashboard/agent-grid';
import { useAgentStream } from '@/hooks/use-agent-stream';

export function AgentsWarRoom() {
  const { agents, isConnected } = useAgentStream();

  // Map hook's lowercase keys to AgentGrid's Title-case keys
  const gridAgents: Record<string, (typeof agents)[string]> = {};
  for (const [key, state] of Object.entries(agents)) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    gridAgents[name] = state;
  }

  return (
    <div className="flex-1 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[13px] font-medium text-sf-text-secondary uppercase tracking-wider">
          Agent Status
        </h2>
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-sf-success' : 'bg-sf-text-tertiary'}`}
          title={isConnected ? 'Connected' : 'Disconnected'}
        />
      </div>
      <AgentGrid agents={gridAgents} />
    </div>
  );
}
