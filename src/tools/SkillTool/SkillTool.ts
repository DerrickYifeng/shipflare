// SkillTool — invoke a registered skill from an agent's turn.
// Mode dispatch: SKILL.md frontmatter `context: inline` (default) injects
// content into the caller's conversation as the tool's result; `context: fork`
// spawns an isolated sub-agent.
//
// Phase 1 implementation diverges from spec §7.2 in one detail: ShipFlare's
// buildTool().execute() returns plain TOutput, not CC's {data, newMessages}
// shape. We package the skill content as the tool's text output — the model
// sees it on the next turn just like any other tool result. Same
// LLM-observable behavior, simpler implementation.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { SKILL_TOOL_NAME } from './constants';
import { getAllSkills } from './registry';

const log = createLogger('tools:skill');

const SkillToolInputSchema = z
  .object({
    skill: z.string().min(1, 'skill name required'),
    args: z.string().optional(),
  })
  .strict();

export type SkillToolInput = z.infer<typeof SkillToolInputSchema>;

export interface SkillToolOutput {
  /** Always true unless an error was thrown. */
  success: boolean;
  /** Echo of the skill name invoked. */
  commandName: string;
  /** Execution mode the skill ran under. */
  status: 'inline' | 'forked';
  /** The skill's resolved prompt content (inline) or sub-agent result (forked). */
  content: string;
}

export const skillTool: ToolDefinition<SkillToolInput, SkillToolOutput> = buildTool({
  name: SKILL_TOOL_NAME,
  description:
    'Invoke a registered skill by name. (Description is replaced with the live roster at agent-spawn time via prompt.ts.)',
  inputSchema: SkillToolInputSchema,
  isReadOnly: false,
  isConcurrencySafe: false,
  async execute(input, ctx): Promise<SkillToolOutput> {
    const all = await getAllSkills();
    const cmd = all.find((s) => s.name === input.skill);
    if (!cmd) {
      throw new Error(
        `Unknown skill: "${input.skill}". Registered skills: ${all.map((s) => s.name).join(', ') || '<none>'}`,
      );
    }

    log.info(`SkillTool: invoking "${cmd.name}" (context=${cmd.context})`);

    // Inline mode (Task 8) and fork mode (Task 9) implementations land in
    // separate tasks. Phase 1 skeleton throws so the test for unknown skill
    // passes while we wire each mode incrementally.
    if (cmd.context === 'inline') {
      throw new Error(
        'NOT_IMPLEMENTED: inline mode lands in Task 8',
      );
    }
    throw new Error('NOT_IMPLEMENTED: fork mode lands in Task 9');
  },
});
