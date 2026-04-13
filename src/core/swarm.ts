import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { AgentConfig, AgentResult, CacheSafeParams, OnProgress, StreamEvent, ToolContext } from './types';
import { runAgent, createToolContext } from './query-loop';
import { buildCacheSafeBlocks } from './api-client';
import { toAnthropicTool } from './tool-system';
import { createLogger } from '@/lib/logger';

const log = createLogger('core:swarm');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmConfig {
  /** Maximum number of agents running in parallel. Default: 5. */
  maxConcurrency?: number;
  /** Timeout per agent in milliseconds. Default: 60_000. */
  timeoutPerAgent?: number;
  /** Progress callback for SSE streaming. */
  onProgress?: OnProgress;
}

export interface AgentTask<T = unknown> {
  /** Agent configuration (loaded from .md file). */
  agentConfig: AgentConfig;
  /** User message sent to the agent. */
  userMessage: string;
  /** Tool context with dependencies (e.g. redditClient). */
  toolContext: ToolContext;
  /** Output schema for validated JSON extraction. */
  outputSchema?: z.ZodType<T>;
  /** Per-agent progress callback (overrides swarm-level). */
  onProgress?: OnProgress;
  /** Optional label for logging/debugging. */
  label?: string;
}

/**
 * Simplified task for cache-safe fan-out.
 * No agentConfig per task — shared via CacheSafeParams.
 */
export interface CachedAgentTask<T = unknown> {
  /** User message sent to the agent. */
  userMessage: string;
  /** Tool context with dependencies (e.g. redditClient). */
  toolContext: ToolContext;
  /** Output schema for validated JSON extraction. */
  outputSchema?: z.ZodType<T>;
  /** Per-agent progress callback (overrides swarm-level). */
  onProgress?: OnProgress;
  /** Optional label for logging/debugging. */
  label?: string;
}

export type AgentTaskResult<T = unknown> =
  | { status: 'completed'; result: AgentResult<T>; label?: string }
  | { status: 'failed'; error: string; label?: string }
  | { status: 'timeout'; label?: string };

// ---------------------------------------------------------------------------
// Semaphore for concurrency limiting
// ---------------------------------------------------------------------------

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// SwarmCoordinator (ported from engine/coordinator/coordinatorMode.ts)
// ---------------------------------------------------------------------------

/**
 * Multi-agent coordinator with concurrency control, timeouts, and
 * error isolation. Ported from engine's coordinator + AgentTool patterns.
 *
 * Two modes:
 * - fanOut: run N agents in parallel with concurrency limit
 * - pipeline: sequential phases, each can fan-out internally
 */
export class SwarmCoordinator {
  private readonly maxConcurrency: number;
  private readonly timeoutPerAgent: number;
  private readonly onProgress?: OnProgress;

  constructor(config: SwarmConfig = {}) {
    this.maxConcurrency = config.maxConcurrency ?? 5;
    this.timeoutPerAgent = config.timeoutPerAgent ?? 60_000;
    this.onProgress = config.onProgress;
  }

  /**
   * Fan-out: run N agents in parallel with concurrency limit.
   * Error isolation: one agent failure produces an error result, others continue.
   * Timeout: per-agent AbortController with timeout.
   */
  async fanOut<T>(tasks: AgentTask<T>[]): Promise<AgentTaskResult<T>[]> {
    log.debug(`Swarm fan-out: ${tasks.length} tasks, max concurrency ${this.maxConcurrency}`);
    const semaphore = new Semaphore(this.maxConcurrency);
    const results: AgentTaskResult<T>[] = [];

    const promises = tasks.map(async (task, index) => {
      await semaphore.acquire();
      try {
        const result = await this.runSingleAgent(task);
        results[index] = result;
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Pipeline: sequential phases, each can fan-out internally.
   * Each phase receives the results of all previous phases.
   */
  async pipeline<T>(phases: PipelinePhase<T>[]): Promise<AgentTaskResult<T>[][]> {
    const allResults: AgentTaskResult<T>[][] = [];

    for (const phase of phases) {
      const tasks = typeof phase.tasks === 'function'
        ? phase.tasks(allResults)
        : phase.tasks;

      const phaseResults = await this.fanOut(tasks);
      allResults.push(phaseResults);

      // Optional synthesis between phases
      if (phase.onComplete) {
        phase.onComplete(phaseResults);
      }
    }

    return allResults;
  }

  /**
   * Fan-out with prompt cache sharing.
   * All agents share the same system prompt, tools, and model from cacheParams.
   * System blocks and tool definitions are computed once, then passed to all
   * child agents via pre-built cache blocks — agents 2-N get Anthropic cache
   * hits on the shared prefix (~90% cost reduction on cached portion).
   */
  async fanOutCached<T>(
    cacheParams: CacheSafeParams,
    tasks: CachedAgentTask<T>[],
  ): Promise<AgentTaskResult<T>[]> {
    // Pre-compute shared blocks ONCE
    const anthropicTools = cacheParams.tools.map(toAnthropicTool);
    const { systemBlocks, cachedTools } = buildCacheSafeBlocks({
      systemPrompt: cacheParams.systemPrompt,
      tools: anthropicTools,
    });

    const prebuilt = {
      systemBlocks,
      cachedTools,
      forkContextMessages: cacheParams.forkContextMessages,
    };

    const sharedConfig: AgentConfig = {
      name: 'cached-agent',
      systemPrompt: cacheParams.systemPrompt,
      model: cacheParams.model,
      tools: cacheParams.tools,
      maxTurns: cacheParams.maxTurns,
    };

    const semaphore = new Semaphore(this.maxConcurrency);
    const results: AgentTaskResult<T>[] = [];

    const promises = tasks.map(async (task, index) => {
      await semaphore.acquire();
      try {
        const result = await this.runSingleCachedAgent(task, sharedConfig, prebuilt);
        results[index] = result;
      } finally {
        semaphore.release();
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Run a single agent with timeout and error isolation.
   */
  private async runSingleAgent<T>(task: AgentTask<T>): Promise<AgentTaskResult<T>> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutPerAgent);

    // Build a tool context that respects the timeout abort
    const timedContext: ToolContext = {
      abortSignal: abortController.signal,
      get<V>(key: string): V {
        return task.toolContext.get<V>(key);
      },
    };

    try {
      const result = await runAgent<T>(
        task.agentConfig,
        task.userMessage,
        timedContext,
        task.outputSchema,
        task.onProgress ?? this.onProgress,
      );

      return { status: 'completed', result, label: task.label };
    } catch (error) {
      if (abortController.signal.aborted) {
        log.warn(`Agent "${task.label}" timed out after ${this.timeoutPerAgent}ms`);
        return { status: 'timeout', label: task.label };
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Agent "${task.label}" failed: ${message}`);
      return { status: 'failed', error: message, label: task.label };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Run a single cached agent with timeout and error isolation.
   * Passes pre-built cache blocks to runAgent for cache sharing.
   */
  private async runSingleCachedAgent<T>(
    task: CachedAgentTask<T>,
    sharedConfig: AgentConfig,
    prebuilt: {
      systemBlocks: Anthropic.Messages.TextBlockParam[];
      cachedTools?: Anthropic.Messages.Tool[];
      forkContextMessages?: Anthropic.Messages.MessageParam[];
    },
  ): Promise<AgentTaskResult<T>> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutPerAgent);

    const timedContext: ToolContext = {
      abortSignal: abortController.signal,
      get<V>(key: string): V {
        return task.toolContext.get<V>(key);
      },
    };

    try {
      const result = await runAgent<T>(
        sharedConfig,
        task.userMessage,
        timedContext,
        task.outputSchema,
        task.onProgress ?? this.onProgress,
        prebuilt,
      );

      return { status: 'completed', result, label: task.label };
    } catch (error) {
      const onProg = task.onProgress ?? this.onProgress;
      if (abortController.signal.aborted) {
        log.warn(`Cached agent "${task.label}" timed out after ${this.timeoutPerAgent}ms`);
        onProg?.({ type: 'agent_error', community: task.label, error: 'timeout' });
        return { status: 'timeout', label: task.label };
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Cached agent "${task.label}" failed: ${message}`);
      onProg?.({ type: 'agent_error', community: task.label, error: message });
      return { status: 'failed', error: message, label: task.label };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface PipelinePhase<T = unknown> {
  name: string;
  tasks: AgentTask<T>[] | ((prevResults: AgentTaskResult<T>[][]) => AgentTask<T>[]);
  onComplete?: (results: AgentTaskResult<T>[]) => void;
}
