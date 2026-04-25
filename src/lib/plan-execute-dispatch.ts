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
  // plan-execute's writer branch owns the DRAFT phase for content_post +
  // x/reddit (post-writer spawned via team-run). The EXECUTE phase still
  // flows through dispatch → posting, since posting is an actual
  // runtime-loaded skill (src/skills/posting) that the execute branch uses
  // as a string label to advance the state machine.
  {
    kind: 'content_post',
    channel: 'x',
    route: {
      draftSkill: null, // writer branch handles draft — dispatcher not consulted for draft phase
      executeSkill: 'posting',
      defaultUserAction: 'approve',
    },
  },
  // --- content_reply ---
  // Reply drafting is owned end-to-end by the community-manager team-run
  // agent (Phase 6 of the agent-cleanup migration absorbed the
  // `draft-single-reply` skill + the `reply-drafter` Task teammate). The
  // dispatch route stays so plan_items still flow through the state
  // machine — but `draftSkill` is null because the actual draft comes
  // from the discovery → community-manager Task fan-out, not from a
  // dispatcher-routed skill.
  {
    kind: 'content_reply',
    channel: 'x',
    route: {
      draftSkill: null,
      executeSkill: 'posting',
      defaultUserAction: 'approve',
    },
  },
  // --- email_send ---
  // Phase E Day 3: deleted draft-email + send-email skills. Email rows still
  // flow through the dispatcher as a manual-completion path so the
  // content-planner's prose playbook doesn't emit dead-on-arrival jobs.
  // A future phase can wire a team-run email agent here.
  {
    kind: 'email_send',
    channel: null,
    route: {
      draftSkill: null,
      executeSkill: null,
      defaultUserAction: 'manual',
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
      // the founder takes the asset off-platform. The individual launch-
      // asset skills (draft-hunter-outreach, draft-waitlist-page, etc.)
      // were deleted in Phase E Day 3 — the per-row skillName is now just
      // a label until Phase F wires replacements.
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
  // Phase E Day 3: analytics-summarize skill deleted. Manual-completion
  // shell keeps the row advancing through the state machine until a future
  // phase re-introduces analytics via team-run or a dedicated worker.
  {
    kind: 'metrics_compute',
    channel: null,
    route: {
      draftSkill: null,
      executeSkill: null,
      defaultUserAction: 'auto',
    },
  },
  // --- analytics_summary ---
  {
    kind: 'analytics_summary',
    channel: null,
    route: {
      draftSkill: null,
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
