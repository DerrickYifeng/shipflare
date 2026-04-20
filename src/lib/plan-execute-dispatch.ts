/**
 * plan-execute dispatch table.
 *
 * Maps `(plan_items.kind, channel?)` → the skill name the processor
 * runs in a given phase. See spec §5.1 for the full table.
 *
 * The processor is platform-neutral: it looks up its skill via
 * `dispatchPlanItem()` and never hardcodes "content_post means X".
 * Tightening Reddit support in a future phase = one new row per kind
 * here, not a grep across processors.
 *
 * Draft phase = produce output (LLM call) + write to `drafts` / the
 * plan_item's `output` column. State moves planned → drafted and
 * (after draft-review) → ready_for_review.
 *
 * Execute phase = apply the output (post, send, publish). State moves
 * approved → executing → completed.
 *
 * A `null` skillName means there is no skill for that phase:
 *  - draft=null, execute=set → userAction='auto' items that skip
 *    review (e.g. metrics_compute).
 *  - draft=null, execute=null → userAction='manual' items the user
 *    finishes directly (e.g. interviews).
 *  - draft=set, execute=null → skill produces a deliverable the user
 *    takes off-platform (e.g. draft-waitlist-page; the user hosts the
 *    HTML themselves).
 */

import type { PlanItemUserAction } from './plan-state';

export type PlanItemKind =
  | 'content_post'
  | 'content_reply'
  | 'email_send'
  | 'interview'
  | 'setup_task'
  | 'launch_asset'
  | 'runsheet_beat'
  | 'metrics_compute'
  | 'analytics_summary';

export interface DispatchRoute {
  draftSkill: string | null;
  executeSkill: string | null;
  defaultUserAction: PlanItemUserAction;
}

/**
 * Per-(kind, channel) route. Channel `null` matches any channel; a
 * concrete channel match wins over the null fallback.
 *
 * Reddit paths intentionally resolve to `null` for now — spec says
 * platform tightening happens in Phase 8+; the processor surfaces
 * "no skill registered" as a typed error instead of exploding.
 */
const ROUTES: ReadonlyArray<
  {
    kind: PlanItemKind;
    channel: string | null;
    route: DispatchRoute;
  }
> = [
  // --- content_post ---
  {
    kind: 'content_post',
    channel: 'x',
    route: {
      draftSkill: 'draft-single-post',
      // Execute phase posts to X. Routed through the existing `posting`
      // queue in the processor, which wraps x-post.ts. The dispatch
      // table exposes `posting` as the skill name; the processor maps
      // skill name → queue.
      executeSkill: 'posting',
      defaultUserAction: 'approve',
    },
  },
  // --- content_reply ---
  {
    kind: 'content_reply',
    channel: 'x',
    route: {
      draftSkill: 'draft-single-reply',
      executeSkill: 'posting',
      defaultUserAction: 'approve',
    },
  },
  // --- email_send ---
  {
    kind: 'email_send',
    channel: null,
    route: {
      draftSkill: 'draft-email',
      executeSkill: 'send-email',
      defaultUserAction: 'approve',
    },
  },
  // --- setup_task: skill-backed ---
  {
    kind: 'setup_task',
    channel: null,
    route: {
      // Draft skill varies by plan_items.skillName at runtime. The
      // dispatcher falls back to the row's explicit skillName when
      // this default is null.
      draftSkill: null,
      executeSkill: null,
      defaultUserAction: 'manual',
    },
  },
  // --- interview ---
  {
    kind: 'interview',
    channel: null,
    route: {
      draftSkill: null,
      executeSkill: null,
      defaultUserAction: 'manual',
    },
  },
  // --- launch_asset ---
  {
    kind: 'launch_asset',
    channel: null,
    route: {
      // Launch-asset rows carry their draft skill in `plan_items.skillName`
      // explicitly (set by tactical-planner). No default execute skill —
      // the founder takes the asset off-platform.
      draftSkill: null,
      executeSkill: null,
      defaultUserAction: 'approve',
    },
  },
  // --- runsheet_beat ---
  {
    kind: 'runsheet_beat',
    channel: null,
    route: {
      // Runsheet beats carry their specific skillName in params. The
      // processor reads plan_items.skillName rather than a default.
      draftSkill: null,
      executeSkill: null,
      // Launch-day: auto unless the beat explicitly requires approval.
      defaultUserAction: 'auto',
    },
  },
  // --- metrics_compute ---
  {
    kind: 'metrics_compute',
    channel: null,
    route: {
      draftSkill: null,
      executeSkill: 'analytics-summarize',
      defaultUserAction: 'auto',
    },
  },
  // --- analytics_summary ---
  {
    kind: 'analytics_summary',
    channel: null,
    route: {
      draftSkill: 'analytics-summarize',
      executeSkill: null,
      defaultUserAction: 'auto',
    },
  },
];

export interface PlanItemRoutingInput {
  kind: PlanItemKind;
  channel?: string | null;
  /**
   * Per-row override — `plan_items.skillName` wins over the dispatch
   * table. This is how tactical-planner can assign specific skills
   * for launch_asset / setup_task rows where the default route is
   * null.
   */
  skillName?: string | null;
}

/**
 * Resolve the dispatch route for a plan_item.
 *
 * Prefer exact channel match. Fall back to the `channel: null` row.
 * When the row carries an explicit `skillName`, the draft-phase
 * skill is overridden to that value. Execute-phase skill is never
 * overridden by the row (posting / send-email are always terminal).
 *
 * Returns `null` when no route matches — signals to the processor
 * that the kind isn't wired yet and the job should fail loudly
 * rather than silently skipping.
 */
export function dispatchPlanItem(
  input: PlanItemRoutingInput,
): DispatchRoute | null {
  // Exact channel match first
  const exact = ROUTES.find(
    (r) => r.kind === input.kind && r.channel === (input.channel ?? null),
  );
  const fallback = ROUTES.find(
    (r) => r.kind === input.kind && r.channel === null,
  );
  const base = exact?.route ?? fallback?.route;
  if (!base) return null;

  if (input.skillName) {
    return {
      ...base,
      draftSkill: base.draftSkill ?? input.skillName,
    };
  }
  return base;
}

/**
 * Dev helper: snapshot of the table for logging / debugging. Not a
 * contract — use `dispatchPlanItem()` for routing decisions.
 */
export const DISPATCH_TABLE_SNAPSHOT = ROUTES;
