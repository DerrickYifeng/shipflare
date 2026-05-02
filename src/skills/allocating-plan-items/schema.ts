// allocating-plan-items skill — input + output schemas.
//
// The skill is the pure-transformation core that the multi-turn
// content-planner agent calls once per week. The agent gathers signals
// (strategic_path, stalled items, last-week completions, recent
// milestones, last-14-days X posts) using its own tool calls, packages
// them into the input below, and the skill returns the week's
// plan_items + a list of stalled rows to reschedule. The agent then
// persists by calling `add_plan_item` / `update_plan_item` on each
// returned entry.
//
// Mirrors the planner-visible subset of `plan_items` — `kind`, `phase`,
// `userAction`, `channel`, `scheduledAt`, `skillName`, `params`,
// `title`, `description` — see `src/lib/db/schema/plan-items.ts` and
// `src/tools/schemas.ts#planItemInputSchema` for the canonical shapes.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums (kept in sync with src/tools/schemas.ts and db/schema)
// ---------------------------------------------------------------------------

const channelEnum = z.enum(['x', 'reddit', 'email']);

const phaseEnum = z.enum([
  'foundation',
  'audience',
  'momentum',
  'launch',
  'compound',
  'steady',
]);

const kindEnum = z.enum([
  'content_post',
  'content_reply',
  'email_send',
  'interview',
  'setup_task',
  'launch_asset',
  'runsheet_beat',
  'metrics_compute',
  'analytics_summary',
]);

const userActionEnum = z.enum(['auto', 'approve', 'manual']);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Slice of `strategic_paths` the allocator needs. The caller agent
 * passes through the row it loaded via `query_strategic_path`. We don't
 * tighten the JSON-typed sub-fields (`thesisArc`, `channelMix`,
 * `milestones`) — they are validated by the Strategic Planner at write
 * time and shapes evolve. Letting the allocator read them as
 * `unknown`-equivalents keeps the contract resilient when new optional
 * fields land upstream.
 */
const strategicPathInputSchema = z.object({
  thesis: z.string().min(1),
  phase: phaseEnum,
  contentPillars: z.array(z.string()),
  channelMix: z.record(z.string(), z.unknown()).optional(),
  thesisArc: z.array(z.unknown()).optional(),
  milestones: z.array(z.unknown()).optional(),
  phaseGoals: z.record(z.string(), z.unknown()).optional(),
  pathId: z.string().min(1).optional(),
});

const signalsInputSchema = z.object({
  /** `query_stalled_items` output — last week's `planned`-but-undone items. */
  stalledItems: z.array(z.unknown()).default([]),
  /** `query_last_week_completions` output — finished items + engagement. */
  lastWeekCompletions: z.array(z.unknown()).default([]),
  /** `query_recent_milestones` output — last 14 days of shipping signals. */
  recentMilestones: z.array(z.unknown()).default([]),
  /** Optional `query_recent_x_posts` output — drives metaphor_ban. */
  recentXPosts: z.array(z.unknown()).optional(),
});

export const allocatingPlanItemsInputSchema = z.object({
  strategicPath: strategicPathInputSchema,
  signals: signalsInputSchema,
  /** Channels the user has connected (`['x']`, `['x', 'reddit', 'email']`, …). */
  connectedChannels: z.array(channelEnum).min(1),
  /** Monday 00:00 UTC of the week to plan, ISO date or full timestamp. */
  targetWeekStart: z.string().min(1),
  /** Current UTC timestamp (ISO). Drives "never schedule in the past". */
  now: z.string().optional(),
  /** Optional caller hint — kickoff/weekly/phase_transition. */
  trigger: z.enum(['kickoff', 'weekly', 'phase_transition']).optional(),
});

export type AllocatingPlanItemsInput = z.infer<
  typeof allocatingPlanItemsInputSchema
>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * One returned plan_item row. The agent passes each entry verbatim into
 * `add_plan_item` — the field set mirrors `planItemInputSchema` in
 * `src/tools/schemas.ts` so callers can spread without translation.
 */
const planItemRowSchema = z.object({
  kind: kindEnum,
  channel: z.union([channelEnum, z.literal('none')]).nullable(),
  phase: phaseEnum,
  userAction: userActionEnum,
  title: z.string().min(1).max(200),
  description: z.string().max(600).nullable().optional().default(null),
  scheduledAt: z.string().min(1),
  skillName: z.string().nullable().optional().default(null),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * Carryover instruction for a stalled `plan_items` row — the caller
 * agent translates this into an `update_plan_item({ id, scheduledAt })`
 * call rather than calling `add_plan_item` (which would create a
 * duplicate row).
 */
const stalledCarryoverSchema = z.object({
  planItemId: z.string().min(1),
  newScheduledAt: z.string().min(1),
});

export const allocatingPlanItemsOutputSchema = z.object({
  planItems: z.array(planItemRowSchema),
  stalledCarriedOver: z.array(stalledCarryoverSchema).default([]),
  /** Free-form note for the caller. Surface truncations + signal gaps. */
  notes: z.string().default(''),
});

export type AllocatingPlanItemsOutput = z.infer<
  typeof allocatingPlanItemsOutputSchema
>;
