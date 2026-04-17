import { join } from 'path';
import type { z } from 'zod';
import type { SkillConfig } from './skill-loader';
import type { AgentProgressEvent, OnProgress, UsageSummary } from './types';
import { SwarmCoordinator } from './swarm';
import type { AgentTaskResult, CachedAgentTask } from './swarm';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { createToolContext } from './query-loop';
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
// Helpers
// ---------------------------------------------------------------------------

const AGENTS_DIR = join(process.cwd(), 'src', 'agents');

function mergeUsage(summaries: UsageSummary[]): UsageSummary {
  const merged: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    model: summaries[0]?.model ?? 'unknown',
    turns: 0,
  };
  for (const s of summaries) {
    merged.inputTokens += s.inputTokens;
    merged.outputTokens += s.outputTokens;
    merged.cacheReadTokens += s.cacheReadTokens;
    merged.cacheWriteTokens += s.cacheWriteTokens;
    merged.costUsd += s.costUsd;
    merged.turns += s.turns;
  }
  return merged;
}

function collectResults<T>(
  taskResults: AgentTaskResult<T>[],
): { results: T[]; usages: UsageSummary[]; errors: { label: string; error: string }[] } {
  const results: T[] = [];
  const usages: UsageSummary[] = [];
  const errors: { label: string; error: string }[] = [];

  for (const tr of taskResults) {
    if (tr.status === 'completed') {
      results.push(tr.result.result);
      usages.push(tr.result.usage);
    } else if (tr.status === 'failed') {
      errors.push({ label: tr.label ?? 'unknown', error: tr.error });
    } else if (tr.status === 'timeout') {
      errors.push({ label: tr.label ?? 'unknown', error: 'Agent timed out' });
    }
  }

  return { results, usages, errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a loaded skill.
 *
 * If the skill defines `fanOut`, the input field named by `fanOut` is
 * treated as an array, and one agent is spawned per element. Otherwise,
 * a single agent runs with the full input.
 *
 * When `cacheSafe` is true, uses SwarmCoordinator.fanOutCached() so
 * agents 2-N share the Anthropic prompt cache prefix.
 */
export async function runSkill<T>(config: SkillRunConfig<T>): Promise<SkillRunResult<T>> {
  const { skill, input, deps = {}, memoryPrompt, outputSchema, onProgress, runId } = config;
  log.info(`Running skill "${skill.name}" fanOut=${skill.fanOut ?? 'none'}`);

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

  const coordinator = new SwarmCoordinator({
    maxConcurrency: skill.maxConcurrency ?? 5,
    timeoutPerAgent: skill.timeout ?? 60_000,
  });

  // Fan-out mode: parallelize by input field
  if (skill.fanOut) {
    const fanOutValues = input[skill.fanOut];
    if (!Array.isArray(fanOutValues)) {
      throw new Error(
        `Skill "${skill.name}" fan-out field "${skill.fanOut}" is not an array in input`,
      );
    }

    log.info(`Fan-out: ${fanOutValues.length} tasks, concurrency=${skill.maxConcurrency ?? 5}`);

    const tasks: CachedAgentTask<T>[] = fanOutValues.map((value) => {
      const itemInput = { ...input, [skill.fanOut!]: undefined, ...resolveItemInput(skill.fanOut!, value, input) };
      const label = typeof value === 'string' ? value : String(value);

      return {
        userMessage: JSON.stringify(itemInput),
        toolContext: createToolContext(deps),
        outputSchema,
        label,
        onProgress: onProgress
          ? (event: AgentProgressEvent) => {
              onProgress({ ...event, community: label } as AgentProgressEvent);
            }
          : undefined,
      };
    });

    let taskResults: AgentTaskResult<T>[];

    if (skill.cacheSafe) {
      taskResults = await coordinator.fanOutCached<T>(
        {
          systemPrompt: agentConfig.systemPrompt,
          tools: agentConfig.tools,
          model: agentConfig.model,
          maxTurns: agentConfig.maxTurns,
        },
        tasks,
      );
    } else {
      // Convert cached tasks to full tasks
      const fullTasks = tasks.map((t) => ({
        agentConfig,
        ...t,
      }));
      taskResults = await coordinator.fanOut<T>(fullTasks);
    }

    const { results, usages, errors } = collectResults(taskResults);
    const merged = mergeUsage(usages);
    log.info(`Skill "${skill.name}" complete: ${results.length} results, ${errors.length} errors`);
    if (runId) await addCost(runId, merged);
    return { results, usage: merged, errors };
  }

  // Single agent mode
  const { runAgent } = await import('./query-loop');
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

/**
 * Build the per-item input for fan-out.
 * For subreddits fan-out: the item value becomes the subreddit field,
 * and the array field is removed.
 */
function resolveItemInput(
  fanOutField: string,
  value: unknown,
  fullInput: Record<string, unknown>,
): Record<string, unknown> {
  // If the fan-out field is plural (e.g. 'subreddits'), use singular form
  const singularField = fanOutField.endsWith('s')
    ? fanOutField.slice(0, -1)
    : fanOutField;

  const result: Record<string, unknown> = {};

  // Copy product-related fields
  if (fullInput.product && typeof fullInput.product === 'object') {
    const product = fullInput.product as Record<string, unknown>;
    result.productName = product.name;
    result.productDescription = product.description;
    result.keywords = product.keywords;
    result.valueProp = product.valueProp;
  }

  // Copy top-level product fields if not nested
  if (fullInput.productName) result.productName = fullInput.productName;
  if (fullInput.productDescription) result.productDescription = fullInput.productDescription;
  if (fullInput.keywords) result.keywords = fullInput.keywords;
  if (fullInput.valueProp) result.valueProp = fullInput.valueProp;

  // Set the singular field to the current fan-out value
  result[singularField] = value;

  return result;
}
