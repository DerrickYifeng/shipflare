'use client';

// Onboarding Stage 6 — strategy plan-build status indicator.
//
// Phase 9 adaptation (CF-native chat migration): the legacy activity-trail
// visualisation depended on `useCmoActivity`, which consumed the
// `ActivityEvent` stream forwarded from `forwardActivityToCmo` calls inside
// `onboarding-routes.ts`. That forwarding was retired in Phase 5 alongside
// the CMO McpAgent → AIChatAgent rewrite (commit `f61362a`).
//
// The onboarding wizard still functions via the SSE state machine in
// `onboarding-routes.ts` — when the strategic-path stream emits
// `strategic_done`, the parent stage advances to Stage 7. This component
// only renders a status indicator while the SSE is in flight.
//
// Richer in-flight activity visualisation (reasoning parts, nested agent
// runs, skill events) is a Phase 9 follow-up: it requires routing the
// onboarding flow through CMO's `onChatMessage` (which emits `data-step`
// + `data-skill-*` parts) instead of the bespoke SSE handler. That
// refactor is deferred until the onboarding UX needs it.
//
// `runId` remains on the props for back-compat with the parent component
// (`stage-plan-building.tsx`) — the value is no longer consumed but
// removing it requires a coordinated edit of the call site.

interface PlanBuildActivityProps {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  runId: string;
}

export function PlanBuildActivity({ runId: _runId }: PlanBuildActivityProps) {
  return (
    <div className="rounded-2xl border border-gray-200 p-4 text-sm text-gray-500">
      Preparing strategist…
    </div>
  );
}
