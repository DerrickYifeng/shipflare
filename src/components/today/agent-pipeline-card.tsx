// AgentPipelineCard — dark `#1d1d1f` card listing the 6 brand-locked agents.
// Reused between the onboarding landed hero and any future pipeline widgets.
//
// Agent vocabulary is brand-locked per frontend spec §6. The Today-landed
// status pattern per §7.1: SCOUT + DISCOVERY active, ANALYST + CONTENT queued,
// REVIEW + POSTING idle.

import { AgentDot, type AgentDotState } from '@/components/onboarding/_shared/agent-dot';
import { OnbMono } from '@/components/onboarding/_shared/onb-mono';

export interface PipelineAgent {
  readonly name: string;
  readonly status: AgentDotState;
  readonly detail: string;
}

export const DEFAULT_PIPELINE_AGENTS: readonly PipelineAgent[] = [
  { name: 'SCOUT',     status: 'active', detail: 'scanning 6 subs · 2 handles' },
  { name: 'DISCOVERY', status: 'active', detail: 'indexing threads · 42 so far' },
  { name: 'ANALYST',   status: 'queued', detail: 'awaiting matches' },
  { name: 'CONTENT',   status: 'queued', detail: 'awaiting matches' },
  { name: 'REVIEW',    status: 'idle',   detail: 'adversarial QA ready' },
  { name: 'POSTING',   status: 'idle',   detail: 'rate limiter ready · 0/8 today' },
];

interface AgentPipelineCardProps {
  agents?: readonly PipelineAgent[];
}

function statusLabel(state: AgentDotState): string {
  if (state === 'active') return '● Running';
  if (state === 'queued') return '○ Queued';
  return '○ Idle';
}

function statusColor(state: AgentDotState): string {
  if (state === 'active') return 'var(--sf-success)';
  if (state === 'queued') return 'var(--sf-fg-on-dark-3)';
  return 'var(--sf-fg-on-dark-4)';
}

export function AgentPipelineCard({
  agents = DEFAULT_PIPELINE_AGENTS,
}: AgentPipelineCardProps) {
  const running = agents.filter((a) => a.status === 'active').length;
  return (
    <section
      style={{
        background: 'var(--sf-bg-dark-surface)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <OnbMono color="var(--sf-fg-on-dark-4)">Agent pipeline</OnbMono>
        <OnbMono color="var(--sf-fg-on-dark-4)">
          {agents.length} agents · {running > 0 ? 'running' : 'idle'}
        </OnbMono>
      </div>
      <div style={{ padding: '4px 0' }}>
        {agents.map((a) => (
          <div
            key={a.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 18px',
              opacity: a.status === 'idle' ? 0.48 : 1,
            }}
          >
            <AgentDot state={a.status} />
            <div
              style={{
                fontFamily: 'var(--sf-font-mono)',
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: '-0.08px',
                color: 'var(--sf-fg-on-dark-1)',
                width: 92,
                flexShrink: 0,
              }}
            >
              {a.name}
            </div>
            <div
              style={{
                flex: 1,
                fontSize: 13,
                letterSpacing: '-0.16px',
                color: 'var(--sf-fg-on-dark-2)',
              }}
            >
              {a.detail}
            </div>
            <OnbMono color={statusColor(a.status)} style={{ fontSize: 10 }}>
              {statusLabel(a.status)}
            </OnbMono>
          </div>
        ))}
      </div>
    </section>
  );
}
