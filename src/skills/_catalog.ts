/**
 * Machine-readable skill catalog.
 *
 * Phase 5 (agent-cleanup) trimmed this to skills that still run via
 * `runSkill()`. Phase 6 deleted the last team-run-side skill
 * (`draft-single-reply`) when community-manager absorbed reply drafting
 * end-to-end. Only `voice-extractor` remains — consumed by the
 * voice-extract worker for the `setup_task` plan_item route.
 *
 * Every other former entry (posting, draft-review, product-opportunity-judge,
 * draft-single-reply) is now invoked directly by its caller via
 * `runAgent(loadAgentFromFile(...))` against the unified registry under
 * `src/tools/AgentTool/agents/` — or absorbed entirely (draft-single-reply
 * lives in community-manager's per-thread workflow now).
 */

import { z, type ZodTypeAny } from 'zod';
import { voiceExtractorOutputSchema } from '@/agents/schemas';

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
// Minimal input schemas — one per catalog entry.
// ---------------------------------------------------------------------------

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
