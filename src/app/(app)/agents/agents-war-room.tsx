'use client';

import { useState, useCallback } from 'react';
import { AgentGrid } from '@/components/dashboard/agent-grid';
import { useAgentStream } from '@/hooks/use-agent-stream';
import { Button } from '@/components/ui/button';

type RunState = 'idle' | 'launching' | 'running' | 'error';

export function AgentsWarRoom() {
  const { agents, isConnected } = useAgentStream();
  const [runState, setRunState] = useState<RunState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Detect if any agent is currently active
  const hasActiveAgent = Object.values(agents).some((a) => a.status === 'active');
  const hasCompletedAgent = Object.values(agents).some((a) => a.status === 'complete');

  // Derive effective state: if SSE reports active agents, we're running
  const effectiveState: RunState =
    hasActiveAgent ? 'running' : runState === 'launching' ? 'launching' : runState;

  const handleTrigger = useCallback(async () => {
    setRunState('launching');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/automation/run', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        setErrorMsg(data.error ?? 'Failed to start automation');
        setRunState('error');
        return;
      }

      // SSE events will transition us to 'running' via hasActiveAgent
      setRunState('running');
    } catch {
      setErrorMsg('Network error — could not reach server');
      setRunState('error');
    }
  }, []);

  // Map hook's lowercase keys to AgentGrid's Title-case keys
  const gridAgents: Record<string, (typeof agents)[string]> = {};
  for (const [key, state] of Object.entries(agents)) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    gridAgents[name] = state;
  }

  const isIdle = effectiveState === 'idle' && !hasActiveAgent && !hasCompletedAgent;

  return (
    <div className="flex-1 p-6">
      {/* Header row */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-[13px] font-medium text-sf-text-secondary uppercase tracking-wider">
            Automation
          </h2>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-sf-success' : 'bg-sf-text-tertiary'}`}
            title={isConnected ? 'Connected' : 'Disconnected'}
          />
        </div>

        <Button
          onClick={handleTrigger}
          disabled={effectiveState === 'launching' || hasActiveAgent}
          variant={hasActiveAgent ? 'secondary' : 'primary'}
          className="gap-2"
        >
          {effectiveState === 'launching' ? (
            <>
              <Spinner />
              Launching...
            </>
          ) : hasActiveAgent ? (
            <>
              <PulsingDot />
              Running
            </>
          ) : (
            <>
              <PlayIcon />
              Run Automation
            </>
          )}
        </Button>
      </div>

      {/* Error banner */}
      {errorMsg && (
        <div className="mb-4 px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light border border-sf-error/20 text-[13px] text-sf-error animate-sf-fade-in">
          {errorMsg}
        </div>
      )}

      {/* Empty state — show before first run */}
      {isIdle && Object.keys(agents).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 animate-sf-fade-in">
          <div className="w-16 h-16 mb-6 rounded-full bg-sf-bg-secondary border border-sf-border flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.2">
              <path d="M9 1L3 9h5l-1 6 6-8H8l1-6z" />
            </svg>
          </div>
          <p className="text-[15px] font-medium text-sf-text-primary mb-1">
            Ready to launch
          </p>
          <p className="text-[13px] text-sf-text-tertiary max-w-[320px] text-center">
            Hit <span className="font-medium text-sf-text-secondary">Run Automation</span> to
            start the pipeline. Your AI agents will scout communities,
            discover threads, draft content, review, and post.
          </p>
        </div>
      ) : (
        <AgentGrid agents={gridAgents} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
 * Micro-components
 * ----------------------------------------------------------------*/

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M3 1.5v11l9-5.5L3 1.5z" />
    </svg>
  );
}

function PulsingDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sf-accent opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-sf-accent" />
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-3.5 w-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
    </svg>
  );
}
