import { join } from 'path';
import type { z } from 'zod';
import type { SkillConfig } from './skill-loader';
import type { OnProgress, UsageSummary } from './types';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { createToolContext, runAgent } from './query-loop';
import { createLogger } from '@/lib/logger';
import { addCost } from '@/lib/cost-bucket';

const log = createLogger('core:skill');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillRunConfig<T = unknown> {
  /** Loaded skill configuration. */
  skill: SkillConfig;
  /** Input data for the skill. */
  input: Record<string, unknown>;
  /** Dependencies to inject into tool context (e.g. redditClient). */
  deps?: Record<string, unknown>;
  /** Memory prompt to append to agent system prompt. */
  memoryPrompt?: string;
  /** Output schema for validated JSON extraction. */
  outputSchema?: z.ZodType<T>;
  /** Progress callback for SSE streaming. */
  onProgress?: OnProgress;
  /**
   * Correlate this skill run's token/USD spend with an outer logical run
   * (typically the BullMQ job's traceId). When set, the final merged
   * UsageSummary is added to the Redis-backed per-run cost bucket so
   * downstream stages can query the running total via
   * `getCostForRun(runId)`. Safe to omit in one-off scripts / tests.
   */
  runId?: string;
}

export interface SkillRunResult<T = unknown> {
  /** Aggregated results from all agents. */
  results: T[];
  /** Combined usage across all agents. */
  usage: UsageSummary;
  /** Errors from failed/timed-out agents. */
  errors: { label: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS_DIR = join(process.cwd(), 'src', 'agents');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a loaded skill as a single agent run.
 *
 * Phase C note: the historical `fanOut` / `cacheSafe` branches routed
 * through `SwarmCoordinator.fanOutCached()` for prompt-cache sharing
 * across N parallel agents. No SKILL.md frontmatter ever declared
 * `fan-out:` in production, so the branch was cold; Phase C Day 2
 * deleted it alongside `src/core/swarm.ts`. The Phase B AgentTool
 * (`Task` tool in src/tools/AgentTool/) is the new fan-out surface —
 * agents spawn parallel child agents via Task calls, not via
 * skill-runner.
 */
export async function runSkill<T>(config: SkillRunConfig<T>): Promise<SkillRunResult<T>> {
  const { skill, input, deps = {}, memoryPrompt, outputSchema, onProgress, runId } = config;
  log.info(`Running skill "${skill.name}"`);

  // Load agent definition
  const agentPath = join(AGENTS_DIR, `${skill.agent ?? skill.name}.md`);
  const agentConfig = loadAgentFromFile(agentPath, registry);

  // Override model if skill specifies one
  if (skill.model) {
    agentConfig.model = skill.model;
  }

  // Append skill references if available
  if (skill.references && Object.keys(skill.references).length > 0) {
    let refBlock = '\n\n## References\n';
    for (const [filename, content] of Object.entries(skill.references)) {
      refBlock += `\n### ${filename}\n\n${content}\n`;
    }
    agentConfig.systemPrompt += refBlock;
  }

  // Append memory prompt if provided
  if (memoryPrompt) {
    agentConfig.systemPrompt += `\n\n## Memory\n\n${memoryPrompt}`;
  }

  const context = createToolContext(deps);
  const result = await runAgent<T>(
    agentConfig,
    JSON.stringify(input),
    context,
    outputSchema,
    onProgress,
  );

  if (runId) await addCost(runId, result.usage);
  return {
    results: [result.result],
    usage: result.usage,
    errors: [],
  };
}
