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
import { spawnSubagent, type SpawnCallbacks } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import {
  resolveSpecialistMemberId,
  wrapOnEventWithSpawnMeta,
} from '@/tools/AgentTool/AgentTool';
import type {
  AgentResult,
  StreamEventSpawnMeta,
  ToolContext,
} from '@/core/types';

/**
 * Spawn a fork-mode skill as a one-shot subagent and return its parsed
 * structured output.
 *
 * @param skillName     Registered skill name (e.g. 'validating-draft')
 * @param args          JSON-serialized input passed to the skill — becomes both
 *                      the $ARGUMENTS substitution token in the system prompt
 *                      and the user message.
 * @param outputSchema  Optional Zod schema; runAgent synthesizes the
 *                      StructuredOutput tool on the skill's tool list when
 *                      provided.
 * @param depsOrParent  Either:
 *                      - a `ToolContext` (from inside a tool's `execute(input, ctx)`)
 *                        → the spawn proxies parent ctx for `userId / productId /
 *                        db / teamId / runId / onEvent`. Use this path when the
 *                        caller is a tool wrapper and the skill's tools need
 *                        domain deps (write_strategic_path, etc.).
 *                      - a plain `Record<string, unknown>` (from a worker
 *                        processor with no parent ctx) → fresh tool context is
 *                        created with the supplied deps. Mirrors
 *                        `createToolContext`'s deps argument.
 *                      Defaults to `{}`.
 *
 * @returns AgentResult<T> — { result, usage }, identical shape to runAgent
 *          so callers can `const { result, usage } = await runForkSkill(...)`.
 */
export async function runForkSkill<T = unknown>(
  skillName: string,
  args: string,
  outputSchema?: ZodType<T>,
  depsOrParent: Record<string, unknown> | ToolContext = {},
): Promise<AgentResult<T>> {
  const all = await getAllSkills();
  const skill = all.find((s) => s.name === skillName);
  if (!skill) throw new Error(`Unknown skill: "${skillName}"`);
  if (skill.context !== 'fork') {
    throw new Error(
      `Skill "${skillName}" is not fork-mode (context=${skill.context})`,
    );
  }

  // Detect a ToolContext by its `abortSignal + get` shape — plain `deps`
  // objects shouldn't carry both. Tool wrappers passing `ctx` straight
  // through will hit this branch; worker processors passing a deps
  // record fall through to `createToolContext(...)`.
  const looksLikeCtx =
    depsOrParent !== null &&
    typeof depsOrParent === 'object' &&
    'abortSignal' in depsOrParent &&
    typeof (depsOrParent as { get?: unknown }).get === 'function';
  const ctx = looksLikeCtx
    ? (depsOrParent as ToolContext)
    : createToolContext(depsOrParent as Record<string, unknown>);

  const systemPrompt = await Promise.resolve(
    skill.getPromptForCommand(args, ctx),
  );

  const def: AgentDefinition = {
    source: 'built-in' as const,
    name: `skill_${skill.name}`,
    description: skill.description,
    tools: skill.allowedTools,
    disallowedTools: [],
    background: false,
    role: 'member',
    requires: [],
    skills: [],
    model: skill.model,
    maxTurns: skill.maxTurns ?? DEFAULT_SKILL_FORK_MAX_TURNS,
    systemPrompt,
    sourcePath: skill.sourcePath ?? `<bundled:${skill.name}>`,
  };

  // Forward the parent's onEvent (if provided via ToolContext) to the
  // fork so the skill's tool_start / tool_done events surface back to
  // the caller. Mirrors the SkillTool fork branch (SkillTool.ts:106) so
  // direct skill invocations from a route or worker can subscribe to
  // per-tool progress without going through team-run pub/sub.
  let onEventFn: SpawnCallbacks['onEvent'] | undefined;
  try {
    const fromCtx = ctx.get<SpawnCallbacks['onEvent'] | null>('onEvent');
    if (typeof fromCtx === 'function') onEventFn = fromCtx;
  } catch {
    onEventFn = undefined;
  }

  // Wrap the forwarded onEvent with spawnMeta so child events attribute
  // to the spawned fork specialist instead of the lead. Mirrors
  // SkillTool.ts:138-159 (the same wiring used by `skill` tool fork
  // calls). Without this, the conversation-reducer's `belongsToSubagent`
  // check (agentName !== 'coordinator' || parentToolUseId) routes the
  // events into the lead's bubble — UI shows the lead "pasting" raw
  // judging JSON.
  //
  // resolveSpecialistMemberId may return null when the ctx isn't
  // team-scoped (CLI / tests / non-team callers — same fallback contract
  // SkillTool's fork branch uses). Even when null, the wrap still
  // injects parentToolUseId + agentName so the UI's delegation card
  // can nest by tool_use_id even without a member id.
  let wrappedOnEvent: SpawnCallbacks['onEvent'] | undefined = onEventFn;
  if (onEventFn) {
    const specialistMemberId = await resolveSpecialistMemberId(
      ctx,
      def.name,
    );
    let parentToolUseId = '';
    try {
      const fromCtx = ctx.get<string | null | undefined>('toolUseId');
      if (typeof fromCtx === 'string' && fromCtx.length > 0) {
        parentToolUseId = fromCtx;
      }
    } catch {
      parentToolUseId = '';
    }
    const spawnMeta: StreamEventSpawnMeta = {
      parentTaskId: null,
      parentToolUseId,
      fromMemberId: specialistMemberId,
      agentName: def.name,
    };
    wrappedOnEvent = wrapOnEventWithSpawnMeta(onEventFn, spawnMeta);
  }
  const callbacks: SpawnCallbacks | undefined = wrappedOnEvent
    ? { onEvent: wrappedOnEvent }
    : undefined;

  return spawnSubagent<T>(def, args, ctx, callbacks, outputSchema);
}
