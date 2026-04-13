import type { ToolDefinition } from '@/core/types';
import { buildTool } from '@/core/tool-system';
import { z } from 'zod';

/**
 * Create a deferred tool placeholder that loads its schema on first use.
 * Ported from engine's shouldDefer tool flag pattern.
 *
 * Reduces startup overhead for MCP servers with many tools:
 * - Tool is registered with minimal metadata
 * - Full schema and execution are resolved on first invocation
 * - Subsequent calls use the resolved schema
 */
export function createDeferredTool(
  serverName: string,
  toolName: string,
  description: string,
  resolveExecute: (input: Record<string, unknown>) => Promise<unknown>,
): ToolDefinition<Record<string, unknown>, unknown> {
  return buildTool({
    name: `mcp__${serverName}__${toolName}`,
    description: `[Deferred:${serverName}] ${description}`,
    isConcurrencySafe: true,
    isReadOnly: true,
    inputSchema: z.record(z.unknown()),
    async execute(input) {
      return resolveExecute(input);
    },
  });
}
