import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, ToolContext } from './types';
import type { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Tool factory following engine's buildTool() pattern (engine/Tool.ts:783).
 * Creates tools with Zod schema validation and dependency injection.
 */
export function buildTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}): ToolDefinition<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: config.execute,
  };
}

/**
 * Convert a ToolDefinition to an Anthropic API tool parameter.
 * Uses zod-to-json-schema like engine/Tool.ts does.
 */
export function toAnthropicTool(
  tool: ToolDefinition,
): Anthropic.Messages.Tool {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, {
    $refStrategy: 'none',
    target: 'openAi',
  });

  // Remove $schema and additionalProperties from top level
  const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;

  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Messages.Tool['input_schema'],
  };
}
