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
// Strategic path (generating-strategy skill writes, coordinator +
// content-planner read)
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
 * Per-week, per-channel ORIGINAL POST allocation. Lives on each
 * `thesisArc[i]` so the strategic path can ramp a foundation week
 * (1-2 posts) into a momentum/launch week (2-4 posts) explicitly,
 * instead of repeating one global `perWeek` across all weeks.
 *
 * Only channels with non-zero allocation need to be present. A week
 * absent of `posts` falls back (in the `derivePerWeekPosts` helper) to
 * the legacy `channelMix.{ch}.perWeek` for back-compat with paths
 * generated before this field landed.
 */
export const strategicThesisWeekPostsSchema = z.object({
  x: z.number().int().min(0).max(14).optional(),
  reddit: z.number().int().min(0).max(14).optional(),
  email: z.number().int().min(0).max(14).optional(),
});

/**
 * One week of the thesis arc. Content-planner reads
 * `thesisArc[thisWeekIndex].theme` and anchors every content_post to it,
 * and reads `thesisArc[i].posts.{ch}` to know how many posts each
 * channel should produce that week.
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
  /**
   * Per-channel ORIGINAL POST counts for this week. Optional during
   * migration: legacy paths predate this field and fall back to
   * `channelMix.{ch}.perWeek` via `derivePerWeekPosts`. New paths from
   * the generating-strategy skill MUST emit this on every week.
   */
  posts: strategicThesisWeekPostsSchema.optional(),
});

/**
 * Channel-level posting settings (cadence preferences + reply budget).
 *
 * Post-quota knob lives on `thesisArc[i].posts.{ch}` — see
 * `strategicThesisWeekPostsSchema`. This object only carries the
 * channel-wide rhythm settings:
 *
 * - `repliesPerDay` is the planned REPLY count per day — the daily
 *   reply-sweep cron uses this as the `targetCount` to fill against
 *   `content_reply` plan_items. Nullish/0 disables reply automation
 *   for the channel (used for Reddit, where high reply volume invites
 *   shadowbans).
 * - `preferredHours` is a small list of UTC hours the planner should
 *   prefer when allocating post / reply-session slots.
 * - `preferredCommunities` applies to reddit only.
 *
 * `.passthrough()` lets legacy rows that still carry `perWeek` survive
 * `parse` so `derivePerWeekPosts` can fall back to it. Once all paths
 * are regenerated this can become `.strict()` and the fallback in
 * `derivePerWeekPosts` can be removed.
 */
export const strategicChannelSettingsSchema = z
  .object({
    repliesPerDay: z.number().int().min(0).max(50).nullish(),
    preferredHours: z.array(z.number().int().min(0).max(23)).min(1).max(6),
    preferredCommunities: z.array(z.string().min(1)).nullish(),
  })
  .passthrough();

/**
 * @deprecated Renamed to `strategicChannelSettingsSchema` once `perWeek`
 * moved out to `thesisArc[i].posts`. Kept as an alias for callers that
 * still import the old name.
 */
export const strategicChannelCadenceSchema = strategicChannelSettingsSchema;

/**
 * Output schema for the `generating-strategy` skill / `write_strategic_path`
 * tool. Mirrors the `strategic_paths` table's jsonb columns so the caller
 * can write directly without remapping.
 */
export const strategicPathSchema = z.object({
  narrative: z.string().min(200).max(2400),
  milestones: z.array(strategicMilestoneSchema).min(3).max(12),
  thesisArc: z.array(strategicThesisWeekSchema).min(1).max(12),
  contentPillars: z.array(z.string().min(1).max(60)).min(3).max(4),
  channelMix: z
    .object({
      x: strategicChannelSettingsSchema.nullish(),
      reddit: strategicChannelSettingsSchema.nullish(),
      email: strategicChannelSettingsSchema.nullish(),
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
export type StrategicThesisWeekPosts = z.infer<
  typeof strategicThesisWeekPostsSchema
>;
export type StrategicThesisWeek = z.infer<typeof strategicThesisWeekSchema>;
export type StrategicChannelSettings = z.infer<
  typeof strategicChannelSettingsSchema
>;
/** @deprecated Use `StrategicChannelSettings`. */
export type StrategicChannelCadence = StrategicChannelSettings;
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
  dueDate: z.string().min(1), // YYYY-MM-DD (date only)
  sortOrder: z.number().int().min(0),
  skillName: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  title: z.string().min(1).max(200),
  description: z.string().max(600).nullable(),
});

export type PlanItemInput = z.infer<typeof planItemInputSchema>;

// ---------------------------------------------------------------------------
// Content-post diversification (content-planner v2 writes via `add_plan_item`)
// ---------------------------------------------------------------------------

/**
 * Content-post diversification params written by content-planner v2.
 * All fields are optional — in-flight items predating the planner v2
 * keep working unchanged. `passthrough` preserves existing keys
 * (e.g. `targetCount`, `theme` in old shape) so legacy params survive.
 */
export const contentPostParamsSchema = z
  .object({
    // Content FORMAT classification (5-value enum). Distinct from the
    // strategic-path's `contentPillars` (free-form TOPIC strings like
    // 'build-in-public', 'marketing-debt'). Topic ≠ format. Renamed
    // from `pillar` (2026-05-04) after LLM planner conflated them.
    format: z
      .enum([
        'milestone',
        'lesson',
        'hot_take',
        'behind_the_scenes',
        'question',
      ])
      .optional(),
    theme: z.string().min(1).max(120).optional(),
    arc_position: z
      .object({
        index: z.number().int().min(1),
        of: z.number().int().min(1),
      })
      .optional(),
    metaphor_ban: z.array(z.string().min(1).max(40)).max(20).optional(),
    cross_refs: z.array(z.string().uuid()).max(5).optional(),
    /**
     * Reddit-only. REQUIRED at AddPlanItemTool when `channel === 'reddit'`.
     * Stored without the `r/` prefix. The runtime check is in
     * AddPlanItemTool — this field is optional at the Zod layer so X
     * content_post params keep validating. Use the same naming bounds
     * as Reddit's own rules: 3..21 chars, [A-Za-z0-9_]+ — same shape
     * as researchingRedditChannelsOutputSchema's subreddit field.
     */
    subreddit: z
      .string()
      .min(3)
      .max(21)
      .regex(/^[A-Za-z0-9_]+$/)
      .optional(),
  })
  .passthrough();

export type ContentPostParams = z.infer<typeof contentPostParamsSchema>;
