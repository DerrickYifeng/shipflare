import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ToolContext, AnyToolDefinition } from './types';

// ---------------------------------------------------------------------------
// buildTool factory (ported from engine/Tool.ts:749-792, merged with bridge)
// ---------------------------------------------------------------------------

/**
 * Tool factory with engine-grade defaults.
 * Combines engine's buildTool() pattern with ShipFlare's flat .ts format.
 *
 * Engine defaults (fail-closed):
 * - isConcurrencySafe: false — must opt-in to parallel execution
 * - isReadOnly: false — must opt-in to mark as side-effect-free
 * - maxResultSizeChars: 100_000 — auto-truncate oversized results
 */
export function buildTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultSizeChars?: number;
  aliases?: string[];
}): ToolDefinition<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: config.execute,
    isConcurrencySafe: config.isConcurrencySafe ?? false,
    isReadOnly: config.isReadOnly ?? false,
    maxResultSizeChars: config.maxResultSizeChars ?? 100_000,
    aliases: config.aliases,
  };
}

// ---------------------------------------------------------------------------
// Anthropic tool conversion
// ---------------------------------------------------------------------------

/**
 * Convert a ToolDefinition to an Anthropic API tool parameter.
 * Uses zod-to-json-schema like engine/Tool.ts does.
 *
 * Target: `jsonSchema7`. The prior `openAi` target emitted
 * `exclusiveMinimum: true` (draft-4 boolean form) for `.positive()` /
 * `.negative()` numbers, which Anthropic's draft-2020-12 validator
 * rejects with `tools.N.custom.input_schema: JSON schema is invalid`.
 * jsonSchema7 emits the number form (`exclusiveMinimum: 0`) that is
 * forward-compatible with 2020-12. Also treats `.optional()` as
 * actually-optional instead of `anyOf: [X, null]` + required.
 */
export function toAnthropicTool(tool: ToolDefinition): Anthropic.Messages.Tool {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });

  // Strip the JSON Schema `$schema` meta field — Anthropic rejects it.
  const schema = { ...(jsonSchema as Record<string, unknown>) };
  delete schema.$schema;

  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Messages.Tool['input_schema'],
  };
}

// ---------------------------------------------------------------------------
// Tool Registry (new for ShipFlare, inspired by engine's agentNameRegistry)
// ---------------------------------------------------------------------------

/**
 * Central tool registry for name/alias-based lookup.
 * Replaces ad-hoc Map<string, ToolDefinition> in bridge/load-agent.ts.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly aliases = new Map<string, string>();

  /** Register a tool. Overwrites if name already exists. */
  register(tool: AnyToolDefinition): void {
    this.tools.set(tool.name, tool);
    if (tool.aliases) {
      for (const alias of tool.aliases) {
        this.aliases.set(alias, tool.name);
      }
    }
  }

  /** Lookup by name or alias. Returns undefined if not found. */
  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name) ?? this.tools.get(this.aliases.get(name) ?? '');
  }

  /** Return all registered tools. */
  getAll(): AnyToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Return just the names of registered tools (Set-friendly for filter pipelines). */
  getAllToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Return a subset of tools matching the given names. */
  getForAgent(names: string[]): AnyToolDefinition[] {
    const result: AnyToolDefinition[] = [];
    for (const name of names) {
      const tool = this.get(name);
      if (tool) {
        result.push(tool);
      }
    }
    return result;
  }

  /** Batch register tools from MCP discovery. */
  loadFromMCP(tools: AnyToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Convert to legacy Map format for bridge compatibility. */
  toMap(): Map<string, AnyToolDefinition> {
    return new Map(this.tools);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
