import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { AgentConfig, AgentResult, ToolContext, ToolDefinition } from './types';
import { MODEL_PRICING } from './types';
import { toAnthropicTool } from './build-tool';

const client = new Anthropic();

/**
 * Stateless agent runner following engine's query loop pattern
 * (engine/query.ts:248, engine/QueryEngine.ts:209).
 *
 * Each call is a fresh conversation. No history persists between invocations.
 * Tools are executed inline. The final text response is parsed as JSON and
 * validated against the output schema.
 *
 * Pattern: system prompt + user message → tool loop → structured output.
 */
export async function runAgent<T>(
  config: AgentConfig,
  userMessage: string,
  context: ToolContext,
  outputSchema?: z.ZodType<T>,
): Promise<AgentResult<T>> {
  const anthropicTools = config.tools.map(toAnthropicTool);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;

  for (turns = 1; turns <= config.maxTurns; turns++) {
    if (context.abortSignal.aborted) {
      throw new Error('Agent execution aborted');
    }

    const response = await client.messages.create({
      model: config.model,
      max_tokens: 4096,
      system: config.systemPrompt,
      messages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // If the model wants to use tools, execute them and continue
    if (response.stop_reason === 'tool_use') {
      // Add assistant message with tool_use blocks
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool call and collect results
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tool = config.tools.find(
          (t): t is ToolDefinition<any, any> => t.name === block.name,
        );

        if (!tool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          });
          continue;
        }

        try {
          // Validate input with Zod, then execute
          const validatedInput = tool.inputSchema.parse(block.input);
          const result = await tool.execute(validatedInput, context);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Tool error: ${message}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // end_turn: extract text, parse, validate, return
    const textBlock = response.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );

    if (!textBlock) {
      throw new Error(`Agent ${config.name}: no text in final response`);
    }

    const pricing = MODEL_PRICING[config.model] ?? { input: 3.0, output: 15.0 };
    const costUsd =
      (totalInputTokens / 1_000_000) * pricing.input +
      (totalOutputTokens / 1_000_000) * pricing.output;

    // If an output schema is provided, parse JSON from the text
    if (outputSchema) {
      // Extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonStr = extractJson(textBlock.text);
      const parsed = JSON.parse(jsonStr);
      const validated = outputSchema.parse(parsed);

      return {
        result: validated,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          costUsd,
          model: config.model,
          turns,
        },
      };
    }

    // No schema: return raw text
    return {
      result: textBlock.text as T,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd,
        model: config.model,
        turns,
      },
    };
  }

  throw new Error(
    `Agent ${config.name}: exceeded max turns (${config.maxTurns})`,
  );
}

/**
 * Extract JSON from text that may be wrapped in markdown code blocks.
 * Handles: raw JSON, ```json ... ```, ``` ... ```.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();

  // Try raw JSON first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Try markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Fallback: try to find JSON object/array in the text
  const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }

  return trimmed;
}

/**
 * Create a ToolContext with dependency injection.
 * Following engine's ToolUseContext pattern (engine/Tool.ts:158).
 */
export function createToolContext(
  deps: Record<string, unknown>,
  abortSignal?: AbortSignal,
): ToolContext {
  return {
    abortSignal: abortSignal ?? new AbortController().signal,
    get<T>(key: string): T {
      const value = deps[key];
      if (value === undefined) {
        throw new Error(`Missing dependency: ${key}`);
      }
      return value as T;
    },
  };
}
