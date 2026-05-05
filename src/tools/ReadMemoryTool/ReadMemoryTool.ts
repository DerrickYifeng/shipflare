// read_memory — load the full content of a single agent_memories entry
// scoped to the current (userId, productId).
//
// Why: `buildMemoryPrompt` injects only the memory INDEX
// (`- [name](name) — description`) into agent system prompts, not the
// content. Agents that need the full body of a known memory entry — e.g.
// `discovery-agent` reading the `discovery-rubric` it pastes verbatim
// into its first xAI message — had no way to fetch it. The LLM
// hallucinated a `skill('read-memory', ...)` call which doesn't exist
// (production trace 2026-05-02). This tool closes that gap.
//
// Called by: discovery-agent (and any agent that lists named memory
// entries it needs to read by name).
// Returns: the entry's `name`, `description`, `type`, `content`, plus
// `null` when the entry doesn't exist for this product.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { readDomainDeps } from '@/tools/context-helpers';
import { MemoryStore } from '@/memory/store';

export const READ_MEMORY_TOOL_NAME = 'read_memory';

export const readMemoryInputSchema = z
  .object({
    /** Memory entry name as listed in the system prompt's
     * `<agent-memory>` index — e.g. `discovery-rubric`. */
    name: z.string().min(1, 'memory entry name is required').max(120),
  })
  .strict();

export type ReadMemoryInput = z.infer<typeof readMemoryInputSchema>;

export interface ReadMemoryResult {
  /** True iff the entry exists for the current (userId, productId). */
  found: boolean;
  /** The entry name as stored. Echoed back so the caller can correlate. */
  name: string;
  /** One-line description from the index. Empty when not found. */
  description: string;
  /** Memory type tag (`feedback`, `project`, `reference`, etc.). Empty when not found. */
  type: string;
  /** Full body content. Empty string when not found. */
  content: string;
}

export const readMemoryTool: ToolDefinition<
  ReadMemoryInput,
  ReadMemoryResult
> = buildTool({
  name: READ_MEMORY_TOOL_NAME,
  description:
    'Load the full body of a named memory entry from the current ' +
    'product\'s `<agent-memory>` store. The system prompt only inlines ' +
    'the memory INDEX (name + one-line description per entry); use this ' +
    'tool to read the full content of a specific entry by name. Returns ' +
    '`{ found, name, description, type, content }` — `found: false` and ' +
    'empty strings when the entry does not exist for this product.',
  inputSchema: readMemoryInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input, ctx): Promise<ReadMemoryResult> {
    const { userId, productId } = readDomainDeps(ctx);
    const store = new MemoryStore(userId, productId);
    const entry = await store.loadEntry(input.name);

    if (!entry) {
      return {
        found: false,
        name: input.name,
        description: '',
        type: '',
        content: '',
      };
    }

    return {
      found: true,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      content: entry.content,
    };
  },
});
