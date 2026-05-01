// Worker-side adapter: invoke a registered fork-mode skill the same way
// SkillTool does inline from another agent, but without a parent agent in
// the loop. Used by BullMQ worker processors that previously called
// loadAgentFromFile + runAgent against an AGENT.md.
//
// Mirrors src/tools/SkillTool/SkillTool.ts fork branch — reuses
// getAllSkills() from the existing registry and delegates the
// AgentDefinition → AgentConfig → runAgent plumbing to spawnSubagent
// (which already exists for the AgentTool path).

import type { ZodType } from 'zod';
import { createToolContext } from '@/bridge/agent-runner';
import { getAllSkills } from '@/tools/SkillTool/registry';
import { DEFAULT_SKILL_FORK_MAX_TURNS } from '@/tools/SkillTool/constants';
import { spawnSubagent } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import type { AgentResult } from '@/core/types';

/**
 * Spawn a fork-mode skill as a one-shot subagent and return its parsed
 * structured output.
 *
 * @param skillName     Registered skill name (e.g. 'reviewing-drafts')
 * @param args          JSON-serialized input passed to the skill — becomes both
 *                      the $ARGUMENTS substitution token in the system prompt
 *                      and the user message.
 * @param outputSchema  Optional Zod schema; runAgent synthesizes the
 *                      StructuredOutput tool on the skill's tool list when
 *                      provided.
 *
 * @returns AgentResult<T> — { result, usage }, identical shape to runAgent
 *          so callers can `const { result, usage } = await runForkSkill(...)`.
 */
export async function runForkSkill<T = unknown>(
  skillName: string,
  args: string,
  outputSchema?: ZodType<T>,
): Promise<AgentResult<T>> {
  const all = await getAllSkills();
  const skill = all.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Unknown skill: "${skillName}"`);
  if (skill.context !== 'fork') {
    throw new Error(
      `Skill "${skillName}" is not fork-mode (context=${skill.context})`,
    );
  }

  const ctx = createToolContext({});
  const systemPrompt = await Promise.resolve(
    skill.getPromptForCommand(args, ctx),
  );

  const def: AgentDefinition = {
    name: `skill_${skill.name}`,
    description: skill.description,
    tools: skill.allowedTools,
    skills: [],
    model: skill.model,
    maxTurns: skill.maxTurns ?? DEFAULT_SKILL_FORK_MAX_TURNS,
    systemPrompt,
    sourcePath: skill.sourcePath ?? `<bundled:${skill.name}>`,
  };

  return spawnSubagent<T>(def, args, ctx, undefined, outputSchema);
}
