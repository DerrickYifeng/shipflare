'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';

interface FirstRunProps {
  onItemsReady: () => void;
  /** Whether the user has at least one connected publishing channel. */
  hasChannel?: boolean;
}

// Stages map to the real agent pipeline. Each one advances when the
// corresponding SSE agent_start / agent_complete event arrives.
//
// Backend agent names we observe on the /api/events channel
// (src/workers/processors/*.ts):
//   - 'scout'            (discovery.ts)
//   - 'content-batch'    (content-calendar.ts)
//   - 'reply-drafter'    (monitor.ts)
//   - 'x-metrics'        (metrics.ts — not part of first-run)
// For the Today first-run we care about the scout -> discovery (drafting) ->
// content -> review arc. We collapse 'content-batch' / 'reply-drafter' into
// the 'content' bucket, and treat the draft_reviewed event as 'review'.
const STAGES = ['scout', 'discovery', 'content', 'review'] as const;
type Stage = (typeof STAGES)[number];

const STAGE_COPY: Record<Stage, { label: string; detail: string }> = {
  scout: {
    label: 'Scouting communities',
    detail: 'Finding where your audience is talking.',
  },
  discovery: {
    label: 'Finding discussions',
    detail: 'Surfacing conversations worth joining.',
  },
  content: {
    label: 'Drafting replies',
    detail: 'Writing on-brand drafts for your review.',
  },
  review: {
    label: 'Quality check',
    detail: 'Running safety and tone checks.',
  },
};

interface SSEAgentEvent {
  type:
    | 'agent_start'
    | 'agent_complete'
    | 'draft_reviewed'
    | 'connected'
    | 'heartbeat'
    | string;
  agentName?: string;
}

function agentToStage(agentName: string | undefined): Stage | null {
  if (!agentName) return null;
  if (agentName === 'scout') return 'scout';
  // No explicit 'discovery' backend agent today — scout complete means the
  // discovery/ingest phase is effectively done. Leave the slot advancing on
  // content start below.
  if (agentName === 'content-batch' || agentName === 'reply-drafter') {
    return 'content';
  }
  return null;
}

export function FirstRun({ onItemsReady, hasChannel = true }: FirstRunProps) {
  const [elapsed, setElapsed] = useState(0);
  const [stageIdx, setStageIdx] = useState(0); // 0..STAGES.length
  const [timedOut, setTimedOut] = useState(false);
  const [itemsCount, setItemsCount] = useState(0);
  const [sseConnected, setSseConnected] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const startTime = Date.now();
    const maxWaitMs = 120_000;

    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let tickInterval: ReturnType<typeof setInterval> | null = null;
    let eventSource: EventSource | null = null;
    let reviewSeen = false;

    // 1. Kick off seeding
    (async () => {
      try {
        await fetch('/api/today/seed', { method: 'POST' });
      } catch {
        // Seed failed silently — SSE / polling still drive progress.
      }
    })();

    // 2. Subscribe to SSE for real stage progress (best effort).
    try {
      eventSource = new EventSource('/api/events');
      eventSource.onopen = () => setSseConnected(true);
      eventSource.onmessage = (msg: MessageEvent<string>) => {
        let event: SSEAgentEvent;
        try {
          event = JSON.parse(msg.data) as SSEAgentEvent;
        } catch {
          return;
        }

        if (event.type === 'connected') {
          setSseConnected(true);
          return;
        }

        const stage = agentToStage(event.agentName);

        if (event.type === 'agent_start' && stage) {
          setStageIdx((prev) => Math.max(prev, STAGES.indexOf(stage)));
        } else if (event.type === 'agent_complete' && stage) {
          // Advance *past* the completed stage.
          setStageIdx((prev) => Math.max(prev, STAGES.indexOf(stage) + 1));
        } else if (event.type === 'draft_reviewed' && !reviewSeen) {
          reviewSeen = true;
          setStageIdx((prev) => Math.max(prev, STAGES.indexOf('review') + 1));
        }
      };
      eventSource.onerror = () => {
        setSseConnected(false);
        // Let the fallback time-based tick handle progress — don't spam
        // reconnects during the first run.
      };
    } catch {
      // EventSource unavailable (very old browsers / SSR pre-hydrate) —
      // fall back to time-based progress.
    }

    // 3. Poll /api/today for item arrival.
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/today');
        const data = (await res.json()) as {
          items?: unknown[];
        };
        const count = data.items?.length ?? 0;
        if (count > 0) {
          setItemsCount(count);
          if (pollInterval) clearInterval(pollInterval);
          if (tickInterval) clearInterval(tickInterval);
          if (eventSource) eventSource.close();
          onItemsReady();
          return;
        }
      } catch {
        // Continue polling
      }

      if (Date.now() - startTime > maxWaitMs) {
        if (pollInterval) clearInterval(pollInterval);
        if (tickInterval) clearInterval(tickInterval);
        if (eventSource) eventSource.close();
        setTimedOut(true);
      }
    }, 5000);

    // 4. Tick for elapsed time + graceful fallback animation when SSE is
    //    unreachable. When SSE *is* live, the stage idx is driven by real
    //    events instead of this timer.
    tickInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      setElapsed(Math.min(sec, 120));
    }, 1000);

    return () => {
      if (pollInterval) clearInterval(pollInterval);
      if (tickInterval) clearInterval(tickInterval);
      if (eventSource) eventSource.close();
    };
  }, [onItemsReady]);

  // Effective stage index: when SSE is live, trust real events. When it's
  // not, advance the stage index proportionally to elapsed time so the UI
  // still feels alive.
  const fallbackStageIdx = Math.min(
    Math.floor((elapsed / 120) * STAGES.length),
    STAGES.length,
  );
  const effectiveStageIdx = sseConnected
    ? stageIdx
    : Math.max(stageIdx, fallbackStageIdx);

  const progress = Math.min((effectiveStageIdx / STAGES.length) * 100, 100);
  const currentStage: Stage =
    STAGES[Math.min(effectiveStageIdx, STAGES.length - 1)];

  if (timedOut) {
    const copy = hasChannel
      ? {
          title: 'Still looking...',
          body:
            itemsCount === 0
              ? 'Tried several communities, no matching discussions yet. Try adding more keywords to your product.'
              : 'Your marketing team is still warming up. Check back in a minute.',
          cta: { href: '/settings', label: 'Adjust product details' },
        }
      : {
          title: 'Connect an account to continue',
          body: 'We found discussions worth replying to, but need a connected account to publish on your behalf.',
          cta: { href: '/settings', label: 'Connect an account' },
        };

    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
        <div className="w-16 h-16 rounded-full bg-sf-bg-secondary flex items-center justify-center mb-6">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-sf-text-tertiary"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>

        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
          {copy.title}
        </h2>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-4 text-center max-w-sm leading-[1.47]">
          {copy.body}
        </p>
        <Link
          href={copy.cta.href}
          className="text-[14px] tracking-[-0.224px] font-medium text-sf-accent hover:text-sf-accent/80 transition-colors duration-200"
        >
          {copy.cta.label}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
      <div
        className="w-full max-w-md rounded-[var(--radius-sf-lg)] p-8 text-center"
        style={{ backgroundColor: '#f0f5ff' }}
      >
        <div className="w-14 h-14 rounded-full bg-sf-accent/10 flex items-center justify-center mx-auto mb-6">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-sf-accent animate-pulse"
          >
            <path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </div>

        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
          Your marketing team is getting ready...
        </h2>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-6 leading-[1.47]">
          {STAGE_COPY[currentStage].detail}
        </p>

        <div className="w-full h-1.5 bg-sf-bg-secondary rounded-full overflow-hidden mb-4">
          <div
            className="h-full bg-sf-accent rounded-full transition-all duration-1000 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="flex justify-between text-[11px] uppercase tracking-[0.6px] text-sf-text-tertiary">
          {STAGES.map((stage, idx) => (
            <span
              key={stage}
              className={
                idx < effectiveStageIdx
                  ? 'text-sf-accent'
                  : idx === effectiveStageIdx
                    ? 'text-sf-text-secondary'
                    : 'text-sf-text-tertiary'
              }
            >
              {STAGE_COPY[stage].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
