/**
 * `/plan` — read-only view of `plan_items` from the founder's CMO.
 *
 * Tactical planner emits plan_items via `addPlanItem`; SMM picks them up
 * via `queryPlanItems` (filtered by `pending` + role). This page just
 * dumps the full table newest-first so founders can see what's queued.
 */

import PlanClient from "./_components/plan-client";

export default function PlanPage() {
  return (
    <div>
      <h1>Plan</h1>
      <PlanClient />
    </div>
  );
}
