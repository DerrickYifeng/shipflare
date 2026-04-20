/**
 * Machine-readable skill catalog.
 *
 * Consumed by:
 *   - The tactical-planner prompt (Phase 6) — so the planner knows which
 *     skills exist, what kinds of plan_items they execute, and what shape
 *     `plan_items.params` must take for each.
 *   - The plan-execute dispatcher (Phase 7) — routes plan_items to the
 *     matching skill based on `skillName` (which must match an entry's
 *     `name` field here).
 *
 * Hand-maintained for v1. Auto-generation from SKILL.md frontmatter is a
 * nice-to-have for Phase 5+ once the skill set stops churning.
 *
 * Adding a new skill:
 *   1. Land the skill dir (SKILL.md + agent ref + references/).
 *   2. Add an output schema to `src/agents/schemas.ts` if one doesn't exist.
 *   3. Define an input schema here (or import from schemas.ts).
 *   4. Append a new `SKILL_CATALOG` entry with accurate `supportedKinds`
 *      and `channels` arrays.
 *   5. Run `pnpm test src/skills/__tests__/catalog` to validate.
 */

import { z, type ZodTypeAny } from 'zod';
import {
  discoveryOutputSchema,
  draftReviewOutputSchema,
  postingOutputSchema,
  replyDrafterOutputSchema,
  slotBodyOutputSchema,
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
// Tightening `z.unknown()` members to real fields is a Phase 5 cleanup.
// ---------------------------------------------------------------------------

const productContextSchema = z.object({
  name: z.string(),
  description: z.string(),
  valueProp: z.string().nullable().optional(),
  keywords: z.array(z.string()),
  currentPhase: z.string().optional(),
});

const draftSinglePostInput = z.object({
  // TODO(phase-5): widen to z.enum(['x', 'reddit']) once the Reddit content
  // guide + agent-prompt branch land. Locked to 'x' here so callers that
  // slip through the catalog channel filter get a Zod validation error
  // upfront instead of crashing mid-LLM call.
  platform: z.literal('x'),
  contentType: z.enum([
    'metric',
    'educational',
    'engagement',
    'product',
    'thread',
  ]),
  angle: z.enum([
    'claim',
    'story',
    'contrarian',
    'howto',
    'data',
    'case',
    'synthesis',
  ]),
  topic: z.string().min(1),
  thesis: z.string().min(1),
  thesisSource: z.enum(['milestone', 'top_reply_ratio', 'fallback', 'manual']),
  pillar: z.string().nullable().optional(),
  product: productContextSchema,
  recentPostHistory: z.array(z.string()),
  priorAnglesThisWeek: z.array(
    z.object({
      angle: z.string(),
      topic: z.string(),
      body: z.string(),
    }),
  ),
  isThread: z.boolean(),
  voiceBlock: z.string().nullable(),
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

const discoveryInput = z.object({
  platform: z.string().min(1),
  source: z.string().min(1),
  product: productContextSchema,
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
    name: 'draft-single-post',
    description:
      'Draft one original post (tweet or thread) for a single plan_item of kind content_post. One LLM call per item.',
    inputSchema: draftSinglePostInput,
    outputSchema: slotBodyOutputSchema,
    supportedKinds: ['content_post'],
    // TODO(phase-5): add 'reddit' once the agent prompt + reddit-content-guide land.
    channels: ['x'],
  },
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
    name: 'discovery',
    description:
      'Search a single platform source (subreddit or X query) for on-topic threads and score them.',
    inputSchema: discoveryInput,
    outputSchema: discoveryOutputSchema,
    // Discovery is not directly scheduled via plan_items today — it runs from
    // the search-source fan-out. Listed in the catalog so the dispatcher can
    // still resolve its name if we later wire discovery under a plan_items
    // kind (e.g., setup_task). Empty supportedKinds means "not
    // planner-schedulable" for v1.
    supportedKinds: [],
  },
  {
    name: 'draft-review',
    description:
      'Adversarial quality check for a drafted post or reply. Returns pass/fail per dimension and suggestions.',
    inputSchema: draftReviewInput,
    outputSchema: draftReviewOutputSchema,
    // Like discovery, this is an inline quality gate rather than a
    // plan_items step. The dispatcher will chain it between
    // drafted → ready_for_review for content_post / content_reply items.
    supportedKinds: [],
  },
  {
    name: 'posting',
    description:
      'Publish an approved draft to its platform. Serial worker — never retried, to avoid duplicate publishes.',
    inputSchema: postingInput,
    outputSchema: postingOutputSchema,
    // Posting is the terminal execute-phase step for content_post and
    // content_reply, but the dispatcher selects it directly from the
    // item's execution phase rather than the tactical-planner's skillName
    // field, so it doesn't advertise supportedKinds here.
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
