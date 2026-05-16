'use client';

// Onboarding Stage 6 — real strategist activity feed.
//
// Replaces the synthetic chat used during the plan-build stage with the
// real ActivityTrail powered by `useCmoActivity({ runId })`. The strategic-
// path SSE handler in apps/core (`/internal/onboarding/strategic-path`)
// forwards subagent_dispatch / skill_invoke / tool_call_* events to the
// founder's CMO Durable Object scoped by `runId`. This component is the
// onboarding-side consumer.
//
// Empty state and connection-error fallbacks are intentionally quiet so
// the founder doesn't see scary copy if the WS handshake takes a beat —
// the strategist work is still in flight and will surface as soon as the
// first event arrives.

import { useCmoActivity } from '@/hooks/use-cmo-activity';
import { ActivityTrail } from '@/components/activity/activity-trail';

interface PlanBuildActivityProps {
  runId: string;
}

export function PlanBuildActivity({ runId }: PlanBuildActivityProps) {
  const { events, connectionError } = useCmoActivity({ runId });

  if (connectionError) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Couldn&apos;t connect to the activity feed. The strategist is still
        working.
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 p-4 text-sm text-gray-500">
        Preparing strategist…
      </div>
    );
  }

  return (
    <ActivityTrail
      events={events}
      defaultOpen
      hideTicker
      shell="dispatch-card"
    />
  );
}
