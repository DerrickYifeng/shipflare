/**
 * Machine-readable skill catalog.
 *
 * Phase E Day 3 (Task #23): trimmed to the 5 skills that are still loaded
 * at runtime via `runSkill()` — draft-single-reply, discovery, draft-review,
 * posting, voice-extractor. The v2 atomic-skill set (18 entries) was deleted
 * in the same commit sweep; plan_items that formerly routed through those
 * skills now flow through team-run coordinators (content_post → x-writer /
 * reddit-writer via Task) or have no equivalent yet — Phase F will wire
 * email / launch-asset / analytics paths to agents when/if they come back.
 *
 * Adding a new skill (if we add any back before full team-run migration):
 *   1. Land the skill dir (SKILL.md + agent ref + references/).
 *   2. Add an output schema to `src/agents/schemas.ts` if one doesn't exist.
 *   3. Define an input schema here (or import from schemas.ts).
 *   4. Append a new `SKILL_CATALOG` entry with accurate `supportedKinds`
 *      and `channels` arrays.
 *   5. Run `pnpm test src/skills/__tests__/catalog` to validate.
 */

import { z, type ZodTypeAny } from 'zod';
import {
  draftReviewOutputSchema,
  postingOutputSchema,
  replyDrafterOutputSchema,
  voiceExtractorOutputSchema,
} from '@/agents/schemas';

/**
 * Mirror of the `plan_item_kind` Postgres enum. Kept here as a string-literal
 * union so catalog entries type-check the `supportedKinds` array without
 * needing to import the Drizzle enum at build time.
 */
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

export interface SkillMeta {
  /** Skill name — MUST match the `name:` field in the SKILL.md frontmatter. */
  name: string;
  /** Short human-readable summary, shown in planner prompts. */
  description: string;
  /** Zod schema describing the `input` the skill-runner must receive. */
  inputSchema: ZodTypeAny;
  /** Zod schema for the skill's output. Optional for skills that only side-effect. */
  outputSchema?: ZodTypeAny;
  /**
   * Which `plan_items.kind` values this skill can execute. The dispatcher
   * uses this to validate that a tactical-planner-emitted item is legal to
   * route to the named skill.
   */
  supportedKinds: PlanItemKind[];
  /**
   * Optional platform filter. Absent / empty = platform-agnostic. Otherwise
   * the catalog advertises which channel identifiers the skill handles so the
   * planner can skip it for other platforms.
   */
  channels?: string[];
}

// ---------------------------------------------------------------------------
// Minimal input schemas — one per catalog entry. Prose input shapes still
// live in each SKILL.md for humans; these are the runtime contract.
// ---------------------------------------------------------------------------

const productContextSchema = z.object({
  name: z.string(),
  description: z.string(),
  valueProp: z.string().nullable().optional(),
  keywords: z.array(z.string()),
  currentPhase: z.string().optional(),
});

const draftSingleReplyInput = z.object({
  tweets: z
    .array(
      z.object({
        tweetId: z.string().min(1),
        tweetText: z.string(),
        authorUsername: z.string(),
        platform: z.literal('x'),
        productName: z.string(),
        productDescription: z.string(),
        valueProp: z.string().nullable().optional(),
        keywords: z.array(z.string()),
        canMentionProduct: z.boolean(),
        voiceBlock: z.string().nullable(),
        repairPrompt: z.string().optional(),
      }),
    )
    .min(1),
});

const draftReviewInput = z.object({
  platform: z.string().min(1),
  kind: z.enum(['reply', 'original_post']),
  replyBody: z.string(),
  thread: z
    .object({
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
    })
    .optional(),
  product: productContextSchema,
});

const postingInput = z.object({
  draftId: z.string().min(1),
  channelId: z.string().min(1),
  platform: z.string().min(1),
});

const voiceExtractorInput = z.object({
  userId: z.string().min(1),
  platform: z.string().min(1),
  samplePosts: z.array(z.string()).min(1),
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const SKILL_CATALOG: readonly SkillMeta[] = [
  {
    name: 'draft-single-reply',
    description:
      'Draft one reply to a monitored post or discovered thread. One LLM call per item, runs the product-opportunity-judge pre-pass and validator hardening downstream.',
    inputSchema: draftSingleReplyInput,
    outputSchema: replyDrafterOutputSchema,
    supportedKinds: ['content_reply'],
    channels: ['x'],
  },
  {
    name: 'draft-review',
    description:
      'Adversarial quality check for a drafted post or reply. Returns pass/fail per dimension and suggestions.',
    inputSchema: draftReviewInput,
    outputSchema: draftReviewOutputSchema,
    // Inline quality gate, not a plan_items step. Chained between
    // drafted → ready_for_review for content_post / content_reply items.
    supportedKinds: [],
  },
  {
    name: 'posting',
    description:
      'Publish an approved draft to its platform. Serial worker — never retried, to avoid duplicate publishes.',
    inputSchema: postingInput,
    outputSchema: postingOutputSchema,
    // Selected directly from the item's execution phase, not via skillName.
    supportedKinds: [],
  },
  {
    name: 'voice-extractor',
    description:
      'Extract a voice profile (tone, signature phrases, banned phrases) from a sample of the user\'s historical posts.',
    inputSchema: voiceExtractorInput,
    outputSchema: voiceExtractorOutputSchema,
    supportedKinds: ['setup_task'],
  },
];

/**
 * O(1) lookup helper — returns the catalog entry for a given skill name,
 * or `undefined` when the skill isn't registered. The dispatcher should
 * treat an undefined result as a fatal contract error (tactical-planner
 * emitted an unknown skillName) rather than silently skipping the item.
 */
export function findSkill(name: string): SkillMeta | undefined {
  return SKILL_CATALOG.find((s) => s.name === name);
}

/**
 * Returns the skills that can execute a given plan_item kind on an optional
 * channel. The tactical-planner uses this to pick `skillName` when emitting
 * plan_items; supplying a channel filters skills that advertise a `channels`
 * list. A skill with no `channels` field is treated as channel-agnostic.
 */
export function skillsForKind(
  kind: PlanItemKind,
  channel?: string,
): SkillMeta[] {
  return SKILL_CATALOG.filter((s) => {
    if (!s.supportedKinds.includes(kind)) return false;
    if (!channel) return true;
    if (!s.channels || s.channels.length === 0) return true;
    return s.channels.includes(channel);
  });
}
