// Phase F — generating-strategy skill schemas.
//
// Mirrors the contract the legacy growth-strategist agent fulfilled:
// the skill receives product + recent shipping context + the calendar
// anchors (today + weekStart) the onboarding/phase-change caller has
// pre-computed, calls the `write_strategic_path` tool to persist the
// 30-day arc, and terminates with `{ status, pathId, summary, notes }`
// for the caller (onboarding API route, /api/product/phase, etc.).
//
// The strategic-path payload itself is validated by `strategicPathSchema`
// inside the `write_strategic_path` tool — this file only defines the
// skill's input contract and the terminal StructuredOutput shape.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const milestoneSourceEnum = z.enum(['commit', 'pr', 'release']);

const recentMilestoneSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  source: milestoneSourceEnum,
  atISO: z.string().min(1),
});

const productCategoryEnum = z.enum([
  'dev_tool',
  'saas',
  'consumer',
  'creator_tool',
  'agency',
  'ai_app',
  'other',
]);

const productStateEnum = z.enum(['mvp', 'launching', 'launched']);

const launchPhaseEnum = z.enum([
  'foundation',
  'audience',
  'momentum',
  'launch',
  'compound',
  'steady',
]);

const channelEnum = z.enum(['x', 'reddit', 'email']);

export const generatingStrategyInputSchema = z.object({
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    category: productCategoryEnum.optional(),
    valueProp: z.string().max(600).nullable().optional(),
    targetAudience: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20).optional(),
  }),
  state: productStateEnum,
  currentPhase: launchPhaseEnum,
  channels: z.array(channelEnum).min(1),
  launchDate: z.string().nullable().optional(),
  launchedAt: z.string().nullable().optional(),
  recentMilestones: z.array(recentMilestoneSchema).optional(),
  voiceProfile: z.string().nullable().optional(),
  /** UTC date the skill anchors the thesis arc on (YYYY-MM-DD). */
  today: z.string().min(1),
  /** Monday 00:00 UTC of the ISO week containing `today` (YYYY-MM-DD). */
  weekStart: z.string().min(1),
});

export type GeneratingStrategyInput = z.infer<
  typeof generatingStrategyInputSchema
>;

// ---------------------------------------------------------------------------
// Output (terminal StructuredOutput)
// ---------------------------------------------------------------------------

/**
 * Skill StructuredOutput. Mirrors the legacy growthStrategistOutputSchema:
 * after `write_strategic_path` succeeds, the skill emits status + pathId
 * + a one-paragraph summary for the founder + a notes blob for the
 * downstream tactical planner.
 */
export const generatingStrategyOutputSchema = z.object({
  status: z.enum(['completed', 'failed']),
  pathId: z.string().min(1),
  summary: z.string().min(1),
  notes: z.string(),
});

export type GeneratingStrategyOutput = z.infer<
  typeof generatingStrategyOutputSchema
>;
