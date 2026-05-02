// generate_strategic_path — typed tool wrapper around the
// `generating-strategy` fork-mode skill.
//
// Why a tool wrapper instead of letting the coordinator call the skill
// via the generic `skill` tool: giving the coordinator the unrestricted
// `skill` tool let the LLM freelance and call any registered skill
// (drafting-reply, judging-thread-quality, etc.), then paste raw
// JSON output as user-facing synthesis text. This wrapper lets the
// coordinator trigger strategic-path generation through a single,
// purpose-built entrypoint while losing the unrestricted skill access.
//
// Mirrors `runForkSkill` semantics — the spawned skill calls
// `write_strategic_path` to persist the row; this tool surfaces the
// `pathId` + a one-paragraph `summary` so the coordinator has
// something to summarize for the founder rather than the JSON.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { runForkSkill } from '@/skills/run-fork-skill';
import { generatingStrategyOutputSchema } from '@/skills/generating-strategy/schema';

const log = createLogger('tools:generate-strategic-path');

export const GENERATE_STRATEGIC_PATH_TOOL_NAME = 'generate_strategic_path';

export const generateStrategicPathInputSchema = z
  .object({
    /**
     * The skill input, JSON-serialized. Shape defined by
     * `generatingStrategyInputSchema` in
     * `src/skills/generating-strategy/schema.ts` — pass as a string
     * because the underlying `runForkSkill` API expects the args
     * as a string for $ARGUMENTS substitution into the skill's
     * system prompt.
     */
    args: z
      .string()
      .min(1, 'args (JSON-serialized skill input) is required'),
  })
  .strict();

export type GenerateStrategicPathInput = z.infer<
  typeof generateStrategicPathInputSchema
>;

export interface GenerateStrategicPathResult {
  status: 'completed' | 'failed';
  /** UUID of the strategic_paths row the skill wrote (or updated). */
  pathId: string;
  /**
   * One-paragraph human-facing summary the coordinator should
   * paraphrase (NOT paste verbatim) when reporting to the founder.
   */
  summary: string;
  /** Notes blob for downstream tactical planning. */
  notes: string;
}

export const generateStrategicPathTool: ToolDefinition<
  GenerateStrategicPathInput,
  GenerateStrategicPathResult
> = buildTool({
  name: GENERATE_STRATEGIC_PATH_TOOL_NAME,
  description:
    'Generate the 30-day strategic narrative arc for the current product ' +
    'and persist it to strategic_paths. USE on onboarding, on phase ' +
    'transitions (mvp → launching → launched), or when recent milestones ' +
    'invalidate the active thesis. Pass the skill input as a JSON string ' +
    'in `args` — shape defined by generatingStrategyInputSchema (product, ' +
    'state, currentPhase, channels[], today, weekStart, optional ' +
    'recentMilestones / launchDate / voiceProfile). Returns ' +
    '{ status, pathId, summary, notes } — paraphrase `summary` for the ' +
    'founder, never paste it verbatim. The tool internally spawns the ' +
    'generating-strategy fork skill which writes the strategic_paths row ' +
    'via write_strategic_path before returning.',
  inputSchema: generateStrategicPathInputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<GenerateStrategicPathResult> {
    log.info('generate_strategic_path: invoking generating-strategy skill');
    // Pass parent ctx through so the skill's tools (write_strategic_path,
    // query_strategic_path, query_recent_milestones) can read userId /
    // productId / db / teamId / runId / onEvent off the team-run ctx.
    // Without this, runForkSkill would create an empty ctx and the
    // skill's tools would throw "missing required dependency userId".
    const { result } = await runForkSkill(
      'generating-strategy',
      input.args,
      generatingStrategyOutputSchema,
      ctx,
    );
    return result;
  },
});
