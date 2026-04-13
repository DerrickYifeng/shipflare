'use client';

import { AgentCard } from './agent-card';

interface AgentState {
  status: 'active' | 'complete' | 'idle' | 'error';
  currentTask?: string;
  progress?: number;
  stats: Record<string, number | string>;
  cost?: number;
  duration?: number;
  log?: string[];
}

interface AgentGridProps {
  agents: Record<string, AgentState>;
}

const AGENT_ORDER = ['Scout', 'Discovery', 'Content', 'Review', 'Posting'] as const;

const IDLE_STATE: AgentState = {
  status: 'idle',
  stats: {},
};

export function AgentGrid({ agents }: AgentGridProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {AGENT_ORDER.map((name) => {
        const state = agents[name] ?? IDLE_STATE;

        return (
          <AgentCard
            key={name}
            name={name}
            status={state.status}
            currentTask={state.currentTask}
            progress={state.progress}
            stats={state.stats}
            cost={state.cost}
            duration={state.duration}
            log={state.log}
          />
        );
      })}
    </div>
  );
}
