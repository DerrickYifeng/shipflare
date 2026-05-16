// Ported from src/tools/schemas.ts — the strategic-path subset only.
// Mirrors the shape the Railway `strategic_paths` table held; on CF we
// persist this as the `narrative_json` payload in the CMO DO's
// `strategic_path` table.

import { z } from "zod";

export const strategicMilestoneSchema = z.object({
  atDayOffset: z.number().int(),
  title: z.string().min(1).max(140),
  successMetric: z.string().min(1).max(240),
  phase: z.enum([
    "foundation",
    "audience",
    "momentum",
    "launch",
    "compound",
    "steady",
  ]),
});

export const strategicThesisWeekPostsSchema = z.object({
  x: z.number().int().min(0).max(14).optional(),
  reddit: z.number().int().min(0).max(14).optional(),
  email: z.number().int().min(0).max(14).optional(),
});

export const strategicThesisWeekSchema = z.object({
  weekStart: z.string().min(1),
  theme: z.string().min(1).max(240),
  angleMix: z
    .array(
      z.enum([
        "claim",
        "story",
        "contrarian",
        "howto",
        "data",
        "case",
        "synthesis",
      ]),
    )
    .min(1)
    .max(7),
  posts: strategicThesisWeekPostsSchema.optional(),
});

export const strategicChannelSettingsSchema = z
  .object({
    repliesPerDay: z.number().int().min(0).max(50).nullish(),
    preferredHours: z.array(z.number().int().min(0).max(23)).min(1).max(6),
    preferredCommunities: z.array(z.string().min(1)).nullish(),
  })
  .passthrough();

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
      message: "channelMix must include at least one active channel",
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
export type StrategicPath = z.infer<typeof strategicPathSchema>;
