'use client';

import { useState, useCallback } from 'react';
import { AgentGrid } from '@/components/dashboard/agent-grid';
import {
  useAgentStreamContext,
  type AgentErrorEntry,
} from '@/hooks/agent-stream-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorDrawer } from '@/components/automation/error-drawer';

type RunState = 'idle' | 'launching' | 'running' | 'error';

export function AgentsWarRoom() {
  const { agents, isConnected, errors, dismissError } = useAgentStreamContext();
  const [runState, setRunState] = useState<RunState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [drawerError, setDrawerError] = useState<AgentErrorEntry | null>(null);

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
        if (data.code === 'NO_CHANNEL') {
          setShowConnectDialog(true);
          setRunState('idle');
          return;
        }
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

  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      const res = await fetch('/api/automation/stop', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error ?? 'Failed to stop automation');
      }
    } catch {
      setErrorMsg('Network error — could not reach server');
    } finally {
      setStopping(false);
    }
  }, []);

  const latestError = errors[0] ?? null;

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
          <h2 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-secondary uppercase">
            Automation
          </h2>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-sf-success' : 'bg-sf-text-tertiary'}`}
            title={isConnected ? 'Connected' : 'Disconnected'}
          />
        </div>

        <div className="flex items-center gap-2">
          {latestError && (
            <button
              type="button"
              onClick={() => setDrawerError(latestError)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sf-md)] bg-sf-error-light text-sf-error text-[12px] font-medium hover:opacity-80 transition-opacity"
              aria-label="View error details"
            >
              <ErrorIcon />
              {errors.length > 1 ? `${errors.length} errors` : '1 error'}
            </button>
          )}

          {hasActiveAgent && (
            <Button
              onClick={handleStop}
              disabled={stopping}
              variant="secondary"
              className="gap-2"
            >
              {stopping ? (
                <>
                  <Spinner />
                  Stopping...
                </>
              ) : (
                <>
                  <StopIcon />
                  Stop
                </>
              )}
            </Button>
          )}

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
      </div>

      {/* Error banner */}
      {errorMsg && (
        <div className="mb-4 px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light text-[14px] tracking-[-0.224px] text-sf-error animate-sf-fade-in">
          {errorMsg}
        </div>
      )}

      {/* Empty state — show before first run */}
      {isIdle && Object.keys(agents).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 animate-sf-fade-in">
          <div className="w-16 h-16 mb-6 rounded-full bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.2">
              <path d="M9 1L3 9h5l-1 6 6-8H8l1-6z" />
            </svg>
          </div>
          <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary mb-1">
            Ready to launch
          </p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary max-w-[320px] text-center">
            Hit <span className="font-medium text-sf-text-secondary">Run Automation</span> to
            start the pipeline. Your AI agents will scout communities,
            discover threads, draft content, review, and post.
          </p>
        </div>
      ) : (
        <AgentGrid agents={gridAgents} />
      )}

      <ErrorDrawer
        open={drawerError !== null}
        error={drawerError}
        onClose={() => {
          if (drawerError) dismissError(drawerError.id);
          setDrawerError(null);
        }}
      />

      {/* Connect account dialog */}
      <Dialog
        open={showConnectDialog}
        onClose={() => setShowConnectDialog(false)}
        title="Connect an account"
      >
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed mb-6">
          Automation needs a connected account to discover threads and post on your behalf.
          Connect Reddit, X, or both.
        </p>
        <div className="flex flex-col gap-3 mb-6">
          <Button
            variant="secondary"
            onClick={() => { window.location.href = '/api/reddit/connect'; }}
            className="gap-2 justify-start"
          >
            <RedditIcon />
            Connect Reddit
          </Button>
          <Button
            variant="secondary"
            onClick={() => { window.location.href = '/api/x/connect'; }}
            className="gap-2 justify-start"
          >
            <XIcon />
            Connect X
          </Button>
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setShowConnectDialog(false)}>
            Later
          </Button>
        </div>
      </Dialog>
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

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
      <rect x="2" y="2" width="8" height="8" rx="1" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="6" cy="6" r="5" />
      <path d="M6 3.5v3M6 8.5v.01" strokeLinecap="round" />
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

function RedditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
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
