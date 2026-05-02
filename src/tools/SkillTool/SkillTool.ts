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
import { spawnSubagent, type SpawnCallbacks } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import { DEFAULT_SKILL_FORK_MAX_TURNS, SKILL_TOOL_NAME } from './constants';
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

    // Inline mode (Task 8) injects the skill's prompt into the caller's
    // conversation as the tool's text result. Fork mode (Task 9) spawns a
    // sub-agent.
    if (cmd.context === 'inline') {
      const content = await Promise.resolve(
        cmd.getPromptForCommand(input.args ?? '', ctx),
      );
      return {
        success: true,
        commandName: cmd.name,
        status: 'inline',
        content,
      };
    }

    // Fork mode — spawn an isolated sub-agent whose system prompt is the
    // skill body and whose user message is the args. Tools, model, and
    // turn budget come from the SKILL.md frontmatter.
    const systemPrompt = await Promise.resolve(
      cmd.getPromptForCommand(input.args ?? '', ctx),
    );

    const subAgentDef: AgentDefinition = {
      name: `skill_${cmd.name}`,
      description: cmd.description,
      tools: cmd.allowedTools,
      disallowedTools: [],
      background: false,
      role: 'member',
      requires: [],
      skills: [],  // skills cannot recursively preload skills (Phase 1)
      model: cmd.model,
      maxTurns: cmd.maxTurns ?? DEFAULT_SKILL_FORK_MAX_TURNS,
      systemPrompt,
      sourcePath: cmd.sourcePath ?? `<bundled:${cmd.name}>`,
    };

    // Forward the parent's onEvent (if provided via ToolContext) to the
    // fork so the skill's tool_start / tool_done events land on the same
    // team_messages channel as the parent's. The team-run worker stashes
    // its onEvent under ctx.get('onEvent'); callers that aren't
    // team-scoped won't have it, in which case we pass undefined and the
    // fork runs quietly. Mirrors AgentTool's wiring (AgentTool.ts:380).
    //
    // Without this, fork-mode tool calls (e.g. write_strategic_path
    // inside generating-strategy) never publish to the channel that
    // /api/onboarding/plan's SSE subscriber listens on, and the route
    // times out with "team-run completed without a strategic path"
    // even though the tool actually persisted the row.
    let onEventFn: SpawnCallbacks['onEvent'] | undefined;
    try {
      const fromCtx = ctx.get<SpawnCallbacks['onEvent'] | null>('onEvent');
      if (typeof fromCtx === 'function') onEventFn = fromCtx;
    } catch {
      onEventFn = undefined;
    }
    const callbacks: SpawnCallbacks | undefined = onEventFn
      ? { onEvent: onEventFn }
      : undefined;

    const result = await spawnSubagent<unknown>(
      subAgentDef,
      input.args ?? '',
      ctx,
      callbacks,
      undefined, // no outputSchema
    );

    const resultText =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);

    return {
      success: true,
      commandName: cmd.name,
      status: 'forked',
      content: resultText,
    };
  },
});
