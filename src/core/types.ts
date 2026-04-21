import type { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Tool types (ported from engine/Tool.ts, merged with bridge/types.ts)
// ---------------------------------------------------------------------------

/**
 * Tool definition for ShipFlare headless agents.
 * Combines engine's ToolDef (engine/Tool.ts) with bridge's flat format.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;

  // Engine fields with fail-closed defaults (set via buildTool)
  /** Whether this tool can safely run in parallel. Default: false. */
  isConcurrencySafe: boolean;
  /** Whether this tool is side-effect-free. Default: false. */
  isReadOnly: boolean;
  /** Auto-truncate results exceeding this char count. Default: 100_000. */
  maxResultSizeChars: number;
  /** Alternative names for tool lookup. */
  aliases?: string[];
}

/**
 * Type-erased tool definition for heterogeneous collections (registries,
 * agent `tools: [...]` arrays). Each tool validates its own input via its
 * zod schema at execute time, so the call-site input is `unknown` here —
 * this mirrors the old `ToolDefinition<any, any>` alias with an explicit,
 * lint-friendly shape. Keep function-parameter variance in mind: declaring
 * `execute` as `(input: unknown, ...)` makes this a bivariant-compatible
 * supertype of `ToolDefinition<Specific, ...>` without any casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * Dependency injection context passed to tools at execution time.
 * Ported from engine's ToolUseContext (engine/Tool.ts:158).
 */
export interface ToolContext {
  abortSignal: AbortSignal;
  get<T>(key: string): T;
}

// ---------------------------------------------------------------------------
// Tool result types
// ---------------------------------------------------------------------------

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Stream event types (ported from engine/query.ts)
// ---------------------------------------------------------------------------

/**
 * Provenance tag attached to `tool_start` / `tool_done` events when the
 * emitting agent is a subagent spawned via the Task tool. The Task tool
 * augments its child's events with this field so the top-level event
 * handler (the team-run worker) can attribute each nested tool call to
 * the specialist that ran it AND link it to the `team_tasks.id` row that
 * started the spawn — giving the activity-log UI a complete delegation
 * tree. Only the innermost spawn tags the event; outer spawns preserve
 * the existing tag so leaf events carry their immediate parent.
 */
export interface StreamEventSpawnMeta {
  /** `team_tasks.id` of the spawn that produced this event. */
  parentTaskId: string;
  /** `team_members.id` of the subagent that emitted the event, if resolvable. */
  fromMemberId: string | null;
  /** AGENT.md `name` of the subagent — always present, cheap fallback. */
  agentName: string;
}

export type StreamEvent =
  | {
      type: 'tool_start';
      toolName: string;
      toolUseId: string;
      input: unknown;
      spawnMeta?: StreamEventSpawnMeta;
    }
  | {
      type: 'tool_done';
      toolName: string;
      toolUseId: string;
      result: ToolResult;
      durationMs: number;
      spawnMeta?: StreamEventSpawnMeta;
    }
  | { type: 'text_delta'; text: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_complete'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: 'error'; error: string; recoverable: boolean };

// ---------------------------------------------------------------------------
// Query params (engine/query.ts pattern, adapted for headless)
// ---------------------------------------------------------------------------

export interface QueryParams {
  messages: Anthropic.Messages.MessageParam[];
  systemPrompt: string;
  tools: AnyToolDefinition[];
  model: string;
  maxTurns: number;
  /** Maximum output tokens per API call. Default: 8192. */
  maxOutputTokens?: number;
  /** Structured output schema for guaranteed JSON. */
  outputSchema?: z.ZodType;
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** Event callback for streaming progress. */
  onEvent?: (event: StreamEvent) => void;
  /** Enable prompt caching. Default: true. */
  promptCaching?: boolean;
}

export interface QueryResult<T = unknown> {
  output: T;
  usage: UsageSummary;
}

// ---------------------------------------------------------------------------
// Agent config (kept from bridge/types.ts, extended)
// ---------------------------------------------------------------------------

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: string;
  tools: AnyToolDefinition[];
  maxTurns: number;
  outputSchema?: z.ZodType;
}

/**
 * Cache-critical parameters shared between parallel agents.
 * When agents share identical CacheSafeParams, Anthropic's prompt cache
 * gives hits across all of them (system + tools + model = cache key prefix).
 * Ported from engine/utils/forkedAgent.ts CacheSafeParams.
 */
export interface CacheSafeParams {
  /** Shared system prompt (base text, identical for all children). */
  systemPrompt: string;
  /** Shared tools (order and content must be identical). */
  tools: AnyToolDefinition[];
  /** Shared model identifier. */
  model: string;
  /** Max turns per agent. */
  maxTurns: number;
  /** Maximum output tokens per API call. Default: 8192. */
  maxOutputTokens?: number;
  /**
   * Shared message prefix for cache sharing. Prepended to each
   * child's conversation. Default: [] (no prefix).
   */
  forkContextMessages?: Anthropic.Messages.MessageParam[];
}

/**
 * Agent execution result with usage metrics.
 * Compatible with bridge's AgentResult shape.
 */
export interface AgentResult<T = unknown> {
  result: T;
  usage: UsageSummary;
}

// ---------------------------------------------------------------------------
// Usage / cost tracking (ported from engine/cost-tracker.ts + modelCost.ts)
// ---------------------------------------------------------------------------

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  model: string;
  turns: number;
}

export interface ModelCosts {
  inputTokens: number;
  outputTokens: number;
  promptCacheReadTokens: number;
  promptCacheWriteTokens: number;
}

/**
 * Per-model token costs (USD per million tokens).
 * From Anthropic pricing docs. Includes cache pricing.
 */
export const MODEL_PRICING: Record<string, ModelCosts> = {
  'claude-haiku-4-5-20251001': {
    inputTokens: 0.80,
    outputTokens: 4.00,
    promptCacheWriteTokens: 1.00,
    promptCacheReadTokens: 0.08,
  },
  'claude-sonnet-4-6': {
    inputTokens: 3.00,
    outputTokens: 15.00,
    promptCacheWriteTokens: 3.75,
    promptCacheReadTokens: 0.30,
  },
  'claude-opus-4-6': {
    inputTokens: 15.00,
    outputTokens: 75.00,
    promptCacheWriteTokens: 18.75,
    promptCacheReadTokens: 1.50,
  },
};

// ---------------------------------------------------------------------------
// Progress events for SSE (kept from bridge/types.ts)
// ---------------------------------------------------------------------------

export type AgentProgressEvent =
  | { type: 'scrape_done'; keywords: string[] }
  | { type: 'query_done'; communityCount: number; queriesPerCommunity: number }
  | { type: 'tool_call_start'; query: string; community?: string }
  | { type: 'tool_call_done'; query: string; resultCount: number; community?: string }
  | { type: 'agent_error'; community?: string; error: string }
  | { type: 'scoring' }
  | { type: 'complete' };

export type OnProgress = (event: AgentProgressEvent) => void;
