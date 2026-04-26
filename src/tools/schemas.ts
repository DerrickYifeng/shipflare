// Domain schemas shared by the Phase B domain tools.
//
// Moved from `src/agents/schemas.ts` per spec §11 Phase B Day 1 + §13.
// Only two schemas survive the move — the others live elsewhere
// (StructuredOutput is synthesized per-agent inside runAgent, not here).
//
// `src/agents/schemas.ts` is still imported by tactical-generate /
// re-plan / /api/onboarding/commit; new code imports from
// `src/tools/schemas.ts` instead.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Strategic path (growth-strategist writes, coordinator + content-planner read)
// ---------------------------------------------------------------------------

/**
 * A single milestone on the strategic arc. `atDayOffset` is relative to
 * launch day (negative = pre-launch, positive = post-launch). `phase`
 * is the phase the milestone belongs to — so the tactical planner knows
 * when to surface it.
 */
export const strategicMilestoneSchema = z.object({
  atDayOffset: z.number().int(),
  title: z.string().min(1).max(140),
  successMetric: z.string().min(1).max(240),
  phase: z.enum([
    'foundation',
    'audience',
    'momentum',
    'launch',
    'compound',
    'steady',
  ]),
});

/**
 * One week of the thesis arc. Content-planner reads
 * `thesisArc[thisWeekIndex].theme` and anchors every content_post to it.
 */
export const strategicThesisWeekSchema = z.object({
  weekStart: z.string().min(1), // ISO, Monday 00:00 UTC
  theme: z.string().min(1).max(240),
  angleMix: z
    .array(
      z.enum([
        'claim',
        'story',
        'contrarian',
        'howto',
        'data',
        'case',
        'synthesis',
      ]),
    )
    .min(1)
    .max(7),
});

/**
 * Channel-level cadence.
 *
 * - `perWeek` is the planned ORIGINAL POST count for the week.
 * - `repliesPerDay` is the planned REPLY count per day — the daily
 *   reply-sweep cron uses this as the `targetCount` to fill against
 *   `content_reply` plan_items. Nullish/0 disables reply automation
 *   for the channel (used for Reddit, where high reply volume invites
 *   shadowbans).
 * - `preferredHours` is a small list of UTC hours the planner should
 *   prefer when allocating post / reply-session slots.
 * - `preferredCommunities` applies to reddit only.
 */
export const strategicChannelCadenceSchema = z.object({
  perWeek: z.number().int().min(0).max(21),
  repliesPerDay: z.number().int().min(0).max(50).nullish(),
  preferredHours: z.array(z.number().int().min(0).max(23)).min(1).max(6),
  preferredCommunities: z.array(z.string().min(1)).nullish(),
});

/**
 * Output schema for the growth-strategist agent / `write_strategic_path` tool.
 * Mirrors the `strategic_paths` table's jsonb columns so the caller can write
 * directly without remapping.
 */
export const strategicPathSchema = z.object({
  narrative: z.string().min(200).max(2400),
  milestones: z.array(strategicMilestoneSchema).min(3).max(12),
  thesisArc: z.array(strategicThesisWeekSchema).min(1).max(12),
  contentPillars: z.array(z.string().min(1).max(60)).min(3).max(4),
  channelMix: z
    .object({
      x: strategicChannelCadenceSchema.nullish(),
      reddit: strategicChannelCadenceSchema.nullish(),
      email: strategicChannelCadenceSchema.nullish(),
    })
    .refine((c) => Object.values(c).some((v) => v != null), {
      message: 'channelMix must include at least one active channel',
    }),
  phaseGoals: z.object({
    foundation: z.string().min(1).max(240).nullish(),
    audience: z.string().min(1).max(240).nullish(),
    momentum: z.string().min(1).max(240).nullish(),
    launch: z.string().min(1).max(240).nullish(),
    compound: z.string().min(1).max(240).nullish(),
    steady: z.string().min(1).max(240).nullish(),
  }),
});

export type StrategicMilestone = z.infer<typeof strategicMilestoneSchema>;
export type StrategicThesisWeek = z.infer<typeof strategicThesisWeekSchema>;
export type StrategicChannelCadence = z.infer<
  typeof strategicChannelCadenceSchema
>;
export type StrategicPath = z.infer<typeof strategicPathSchema>;

// ---------------------------------------------------------------------------
// Plan item input (coordinator + content-planner write via `add_plan_item`)
// ---------------------------------------------------------------------------

/**
 * Input schema for the `add_plan_item` tool. Mirrors the planner-visible
 * subset of the `plan_items` table — callers hand us the concrete fields
 * they want to materialize as a row; the tool assigns id + timestamps +
 * state columns.
 */
export const planItemInputSchema = z.object({
  kind: z.enum([
    'content_post',
    'content_reply',
    'email_send',
    'interview',
    'setup_task',
    'launch_asset',
    'runsheet_beat',
    'metrics_compute',
    'analytics_summary',
  ]),
  userAction: z.enum(['auto', 'approve', 'manual']),
  phase: z.enum([
    'foundation',
    'audience',
    'momentum',
    'launch',
    'compound',
    'steady',
  ]),
  channel: z.string().nullable(),
  scheduledAt: z.string().min(1), // ISO
  skillName: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  title: z.string().min(1).max(200),
  description: z.string().max(600).nullable(),
});

export type PlanItemInput = z.infer<typeof planItemInputSchema>;
