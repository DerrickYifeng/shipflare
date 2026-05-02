// Replaces engine/tools/AgentTool/runAgent.ts (Claude Code, 973 LOC).
// ShipFlare's src/core/query-loop.ts already ports engine/query.ts, so spawnSubagent
// is a thin AgentDefinition → AgentConfig adapter — no main-loop logic lives here.
// CacheSafeParams concept (engine/utils/forkedAgent.ts) is preserved via shared
// system prompt + tools between spawns of the same agent type (future optimization).

import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { runAgent } from '@/core/query-loop';
import { createLogger } from '@/lib/logger';
import { registry } from '@/tools/registry';
import { getAllSkills } from '@/tools/SkillTool/registry';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '@/tools/StructuredOutputTool/StructuredOutputTool';
import type {
  AgentConfig,
  AgentResult,
  AnyToolDefinition,
  OnProgress,
  StreamEvent,
  ToolContext,
} from '@/core/types';
import type { AgentDefinition } from './loader';
import { renderRuntimePreamble } from './runtime-preamble';

const log = createLogger('agent:spawn');

/**
 * Default model for subagents that don't declare one in AGENT.md frontmatter.
 * Mirrors the main-agent default used elsewhere in ShipFlare; kept here as a
 * named constant so Phase G can tune it without grepping string literals.
 */
export const DEFAULT_SUBAGENT_MODEL = 'claude-sonnet-4-6';

/**
 * Default turn budget when an AGENT.md omits `maxTurns`. Mirrors the loader's
 * DEFAULT_MAX_TURNS (200) for a single-source-of-truth feel, but we redeclare
 * here so spawn() is self-contained for callers that hand-build AgentDefinitions.
 *
 * 200 matches Claude Code's FORK_AGENT.maxTurns
 * (engine/tools/AgentTool/forkSubagent.ts:65). This is a circuit breaker
 * for runaway loops, not a natural-termination bound — agents should hit
 * StructuredOutput / end_turn long before this.
 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 200;

/**
 * Extended ToolContext carried by subagents. `depth` enforces the spawn-depth
 * limit (spec §16: circular-Task mitigation). Parents increment when launching
 * a child so the chain is observable from anywhere in the stack.
 *
 * `parentTaskId` is reserved for Phase A Day 4 team_tasks wiring — we pass it
 * through today as an opaque string so `spawn()` needs no changes when the DB
 * lands.
 */
export interface ChildToolContext extends ToolContext {
  depth: number;
  parentTaskId?: string;
}

/**
 * Read `depth` off an arbitrary ToolContext. Treats the absence of the field
 * as depth 0 (root delegator) — that's the correct default for the top-level
 * coordinator spawned by the /api/team/run worker.
 */
export function getContextDepth(ctx: ToolContext): number {
  const extended = ctx as Partial<ChildToolContext>;
  return typeof extended.depth === 'number' ? extended.depth : 0;
}

/** Callback bundle forwarded into runAgent's event surface. */
export interface SpawnCallbacks {
  onMessage?: (msg: unknown) => void;
  onToolCall?: (call: unknown) => void;
  onError?: (err: unknown) => void;
  onProgress?: OnProgress;
  /**
   * Tool-lifecycle event callback forwarded into the child runAgent so
   * nested subagents' tool_start / tool_done events share the parent's
   * team_messages channel. The team-run worker sets this per run; ad-hoc
   * callers leave it undefined and the child runs quietly.
   */
  onEvent?: (event: StreamEvent) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// AgentDefinition → AgentConfig adapter
// ---------------------------------------------------------------------------

/**
 * Resolve a subagent's tool allowlist against the central registry. Throws if
 * any declared tool is unknown — fail-closed keeps misconfigured agents from
 * silently launching with a stripped tool list and then hitting
 * "Unknown tool" runtime errors further down the stack.
 *
 * `StructuredOutput` is a synthesized/virtual tool: runAgent appends it to
 * the Anthropic tool list at runtime when the caller provides an
 * `outputSchema`. AGENT.md files that declare it in `tools: [...]` are
 * telling downstream readers ("this agent emits structured output") — the
 * entry isn't resolved here. See src/tools/registry.ts for why it's
 * intentionally not registered.
 */
export function resolveAgentTools(def: AgentDefinition): AnyToolDefinition[] {
  const resolved: AnyToolDefinition[] = [];
  const missing: string[] = [];
  for (const toolName of def.tools) {
    if (toolName === STRUCTURED_OUTPUT_TOOL_NAME) continue;
    const tool = registry.get(toolName);
    if (!tool) {
      missing.push(toolName);
      continue;
    }
    resolved.push(tool);
  }
  if (missing.length > 0) {
    throw new Error(
      `Agent "${def.name}" declares unknown tool(s): ${missing.join(', ')}. ` +
        `Register these in src/tools/registry.ts or remove them from the AGENT.md frontmatter.`,
    );
  }
  return resolved;
}

export function buildAgentConfigFromDefinition(
  def: AgentDefinition,
  now: Date = new Date(),
): AgentConfig {
  return {
    name: def.name,
    systemPrompt: `${renderRuntimePreamble(now)}${def.systemPrompt}`,
    model: def.model ?? DEFAULT_SUBAGENT_MODEL,
    tools: resolveAgentTools(def),
    maxTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
  };
}

// ---------------------------------------------------------------------------
// Child context construction
// ---------------------------------------------------------------------------

/**
 * Fork a parent context for a child subagent:
 *   - fresh AbortController (child can be cancelled independently)
 *   - parent's abort propagates to child (if parent aborts, so do we)
 *   - `get()` delegates through so the child sees the parent's deps
 *   - `depth` increments from parent by 1
 */
export function createChildContext(
  parent: ToolContext,
  parentTaskId?: string,
): ChildToolContext {
  const parentDepth = getContextDepth(parent);
  const childController = new AbortController();

  // Wire parent cancellation → child.
  const forward = () => childController.abort();
  if (parent.abortSignal.aborted) {
    childController.abort();
  } else {
    parent.abortSignal.addEventListener('abort', forward, { once: true });
  }

  const child: ChildToolContext = {
    abortSignal: childController.signal,
    depth: parentDepth + 1,
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    get<V>(key: string): V {
      return parent.get<V>(key);
    },
  };
  return child;
}

// ---------------------------------------------------------------------------
// Skill preload — declare-time hoist of skill bodies into the child's context
// ---------------------------------------------------------------------------

/**
 * Build cache-safe initial messages for skill preload. Empty array when
 * agent declares no skills (caller passes `undefined` to runAgent instead
 * of `{ forkContextMessages: [] }` so systemPrompt cache stays clean).
 *
 * Messages shape: each declared skill becomes one user message containing
 * the skill body. The model reads them as additional context before
 * reaching the user prompt.
 */
async function buildSkillPreloadMessages(
  skillNames: string[],
  ctx: ToolContext,
): Promise<Anthropic.Messages.MessageParam[]> {
  if (skillNames.length === 0) return [];
  const allSkills = await getAllSkills();
  const byName = new Map(allSkills.map((s) => [s.name, s]));

  // Resolve all skill bodies in parallel; preserve declaration order so
  // test #1 in spawn.test.ts (forkContextMessages[0] === first declared
  // skill) keeps holding. Sequential awaits would serialize per-skill I/O
  // (e.g. file-skill `getPromptForCommand` reads from disk) for no reason.
  const resolved = await Promise.all(
    skillNames.map(async (name) => {
      const skill = byName.get(name);
      if (!skill) {
        log.warn(
          `spawn: agent declared skill "${name}" but it is not registered`,
        );
        return null;
      }
      const content = await Promise.resolve(skill.getPromptForCommand('', ctx));
      return { name, content };
    }),
  );

  // Skill names are constrained by SkillFrontmatterSchema's regex
  // (/^[a-z][a-z0-9_-]*$/) and AGENT_NAME_PATTERN, so XML attribute
  // escaping is unnecessary in Phase 1.
  return resolved
    .filter((r): r is { name: string; content: string } => r !== null)
    .map(({ name, content }) => ({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-skill name="${name}">\n${content}\n</system-skill>`,
        },
      ],
    }));
}

// ---------------------------------------------------------------------------
// spawnSubagent — the public entry point
// ---------------------------------------------------------------------------

/**
 * Launch a subagent from an AgentDefinition. Thin wrapper around runAgent():
 *
 *   1. Resolve AgentDefinition → AgentConfig (system prompt, model, tools, turns).
 *   2. Fork the parent ToolContext into a child with incremented depth and a
 *      new AbortController.
 *   3. Call runAgent(); return its AgentResult verbatim.
 *
 * The child's depth-limit check lives in AgentTool.ts (Task tool's execute()),
 * not here — spawnSubagent is the low-level primitive; the Task tool is the
 * policy boundary. Callers that bypass the Task tool (e.g. the top-level
 * /api/team/run worker spawning the coordinator) can legitimately skip the
 * depth check.
 */
export async function spawnSubagent<T = unknown>(
  def: AgentDefinition,
  prompt: string,
  parentCtx: ToolContext,
  callbacks?: SpawnCallbacks,
  outputSchema?: z.ZodType<T>,
  parentTaskId?: string,
): Promise<AgentResult<T>> {
  const config = buildAgentConfigFromDefinition(def);
  const childCtx = createChildContext(parentCtx, parentTaskId);

  const skillPreload = await buildSkillPreloadMessages(def.skills, childCtx);
  const prebuilt =
    skillPreload.length > 0
      ? { systemBlocks: [], forkContextMessages: skillPreload }
      : undefined;

  return runAgent<T>(
    config,
    prompt,
    childCtx,
    outputSchema,
    callbacks?.onProgress,
    prebuilt,
    undefined, // onIdleReset
    callbacks?.onEvent,
  );
}
