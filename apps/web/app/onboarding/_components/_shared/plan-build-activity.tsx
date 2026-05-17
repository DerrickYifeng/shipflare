'use client';

// Onboarding Stage 6 — real-time strategy visualization.
//
// Uses ActivityTrail (the same component as the /team page) so the visual
// language is identical. Text delta events are filtered out before passing
// to ActivityTrail — the strategic planner streams raw JSON chunks that
// aren't human-readable, so we only surface the dispatch + finish rows.
// This gives a clean "Activity (2) ▾" tree: one running/done dispatch row.

import { useMemo } from 'react';
import { useCmoActivity } from '@/hooks/use-cmo-activity';
import { ActivityTrail } from '@/components/activity/activity-trail';
import type { ActivityEvent } from '@shipflare/shared';

interface PlanBuildActivityProps {
  runId: string;
}

export function PlanBuildActivity({ runId }: PlanBuildActivityProps) {
  const { events, connectionError } = useCmoActivity({ runId });

  // Strip raw text delta events — the strategic planner streams JSON chunks
  // that aren't human-readable. Only show dispatch + finish rows.
  const displayEvents = useMemo(
    () => events.filter((e: ActivityEvent) => e.kind !== 'subagent_text_delta'),
    [events],
  );

  if (connectionError) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Couldn&apos;t connect to the activity feed. The strategist is still
        working — you&apos;ll advance automatically when the plan is ready.
      </div>
    );
  }

  if (displayEvents.length === 0) {
    return (
      <div className="rounded-2xl border border-gray-200 p-4 text-sm text-gray-500">
        Preparing strategist…
      </div>
    );
  }

  return (
    <ActivityTrail
      events={displayEvents}
      defaultOpen
      hideTicker
      shell="dispatch-card"
    />
  );
}
