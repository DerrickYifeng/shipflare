import type { z } from 'zod';

/**
 * Tool definition following engine's buildTool() pattern (engine/Tool.ts:783).
 * Simplified for ShipFlare's headless agent use case.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

/**
 * Dependency injection context passed to tools at execution time.
 * Mirrors engine's ToolUseContext (engine/Tool.ts:158) but scoped to ShipFlare.
 */
export interface ToolContext {
  abortSignal: AbortSignal;
  get<T>(key: string): T;
}

/**
 * Agent configuration. Corresponds to engine's agent markdown frontmatter
 * (engine/tools/AgentTool/loadAgentsDir.ts).
 */
export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: ToolDefinition<any, any>[];
  maxTurns: number;
  outputSchema?: z.ZodType;
}

/**
 * Agent execution result with usage metrics.
 * Mirrors engine's cost tracking (engine/services/cost.ts).
 */
export interface AgentResult<T = unknown> {
  result: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    model: string;
    turns: number;
  };
}

/**
 * Model pricing per million tokens. From Anthropic docs.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};
