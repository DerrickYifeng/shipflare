import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition, ToolContext, ToolResult, StreamEvent } from './types';
import { createLogger } from '@/lib/logger';

const log = createLogger('core:tools');

// ---------------------------------------------------------------------------
// Tool batching (ported from engine/services/tools/toolOrchestration.ts:91-116)
// ---------------------------------------------------------------------------

interface ToolBatch {
  concurrent: boolean;
  blocks: Anthropic.Messages.ToolUseBlock[];
}

/**
 * Partition tool_use blocks into execution batches.
 * Consecutive concurrent-safe tools are grouped into a single parallel batch.
 * Non-concurrent-safe tools form singleton serial batches.
 *
 * Ported from engine/services/tools/toolOrchestration.ts:partitionToolCalls.
 */
export function partitionToolCalls(
  blocks: Anthropic.Messages.ToolUseBlock[],
  tools: ToolDefinition<any, any>[],
): ToolBatch[] {
  return blocks.reduce((acc: ToolBatch[], block) => {
    const tool = tools.find((t) => t.name === block.name);
    const isSafe = tool?.isConcurrencySafe ?? false;

    if (isSafe && acc.length > 0 && acc[acc.length - 1]!.concurrent) {
      acc[acc.length - 1]!.blocks.push(block);
    } else {
      acc.push({ concurrent: isSafe, blocks: [block] });
    }
    return acc;
  }, []);
}

// ---------------------------------------------------------------------------
// Tool execution (ported from engine's StreamingToolExecutor + runTools)
// ---------------------------------------------------------------------------

/**
 * Execute a single tool_use block: resolve tool, validate input, run, truncate.
 * Ported from bridge/agent-runner.ts executeToolBlock + engine truncation.
 */
async function executeSingleTool(
  block: Anthropic.Messages.ToolUseBlock,
  tools: ToolDefinition<any, any>[],
  context: ToolContext,
): Promise<{ result: ToolResult; durationMs: number }> {
  const start = Date.now();
  const tool = tools.find((t) => t.name === block.name);

  if (!tool) {
    return {
      result: {
        tool_use_id: block.id,
        content: `Unknown tool: ${block.name}`,
        is_error: true,
      },
      durationMs: Date.now() - start,
    };
  }

  try {
    const validatedInput = tool.inputSchema.parse(block.input);
    const rawResult = await tool.execute(validatedInput, context);
    // JSON.stringify(undefined) returns JS undefined — guard against it
    let content = JSON.stringify(rawResult ?? null) || 'null';

    // Engine's maxResultSizeChars truncation
    if (content.length > tool.maxResultSizeChars) {
      content = content.slice(0, tool.maxResultSizeChars) +
        `\n... [truncated: ${content.length} chars, limit ${tool.maxResultSizeChars}]`;
    }

    const durationMs = Date.now() - start;
    log.debug(`Tool ${block.name} completed in ${durationMs}ms`);
    return {
      result: { tool_use_id: block.id, content },
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Tool ${block.name} failed in ${durationMs}ms: ${message}`);
    return {
      result: {
        tool_use_id: block.id,
        content: `Tool error: ${message}`,
        is_error: true,
      },
      durationMs,
    };
  }
}

/**
 * Execute tool batches with proper concurrency control.
 * Yields StreamEvents for each tool start/done.
 *
 * Ported from engine/services/tools/toolOrchestration.ts:runTools.
 * Simplified: no context modifiers, no permission checks (headless agents).
 */
export async function executeTools(
  blocks: Anthropic.Messages.ToolUseBlock[],
  tools: ToolDefinition<any, any>[],
  context: ToolContext,
  onEvent?: (event: StreamEvent) => void,
): Promise<Anthropic.Messages.ToolResultBlockParam[]> {
  const batches = partitionToolCalls(blocks, tools);
  const allResults: Anthropic.Messages.ToolResultBlockParam[] = [];

  for (const batch of batches) {
    if (context.abortSignal.aborted) {
      // Yield error results for remaining tools
      for (const block of batch.blocks) {
        allResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Execution aborted',
          is_error: true,
        });
      }
      continue;
    }

    if (batch.concurrent) {
      // Emit start events
      for (const block of batch.blocks) {
        onEvent?.({ type: 'tool_start', toolName: block.name, toolUseId: block.id, input: block.input });
      }

      // Run concurrent-safe batch in parallel
      const batchResults = await Promise.all(
        batch.blocks.map((block) => executeSingleTool(block, tools, context)),
      );

      for (let i = 0; i < batch.blocks.length; i++) {
        const block = batch.blocks[i]!;
        const { result, durationMs } = batchResults[i]!;

        onEvent?.({ type: 'tool_done', toolName: block.name, toolUseId: block.id, result, durationMs });

        allResults.push({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        });
      }
    } else {
      // Run non-concurrent-safe batch serially
      for (const block of batch.blocks) {
        if (context.abortSignal.aborted) {
          allResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Execution aborted',
            is_error: true,
          });
          continue;
        }

        onEvent?.({ type: 'tool_start', toolName: block.name, toolUseId: block.id, input: block.input });

        const { result, durationMs } = await executeSingleTool(block, tools, context);

        onEvent?.({ type: 'tool_done', toolName: block.name, toolUseId: block.id, result, durationMs });

        allResults.push({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        });
      }
    }
  }

  return allResults;
}
