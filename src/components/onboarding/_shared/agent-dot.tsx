// AgentDot — 8×8 dot for the agent-pipeline list.
// States: active (pulsing green) / queued (hollow border) / idle (muted).
// Used in stage 2/6 + today landed hero.

export type AgentDotState = 'active' | 'queued' | 'idle';

interface AgentDotProps {
  state: AgentDotState;
}

export function AgentDot({ state }: AgentDotProps) {
  if (state === 'active') {
    return (
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--sf-success)',
          animation: 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
          flexShrink: 0,
        }}
      />
    );
  }
  if (state === 'queued') {
    return (
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          border: '1.5px solid var(--sf-fg-on-dark-3)',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'var(--sf-fg-on-dark-4)',
        flexShrink: 0,
      }}
    />
  );
}
