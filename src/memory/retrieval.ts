import { z } from 'zod';
import { sideQuery } from '@/core/api-client';
import { MemoryStore } from './store';
import type { MemoryEntry } from './types';

const RETRIEVAL_MODEL = 'claude-haiku-4-5-20251001';

const selectedMemoriesSchema = z.object({
  selected_memories: z.array(z.string()),
});

/**
 * Find memories relevant to a query using LLM-based selection.
 * Ported from engine/memdir/findRelevantMemories.ts.
 *
 * Process:
 * 1. List all memory headers → format as manifest
 * 2. Side-query Haiku: "which memories are relevant to this query?"
 * 3. Load and return selected entries
 */
export async function findRelevantMemories(
  query: string,
  store: MemoryStore,
  signal: AbortSignal,
): Promise<MemoryEntry[]> {
  const headers = await store.listEntries();

  if (headers.length === 0) return [];

  // Format manifest (filename + description per line)
  const manifest = headers
    .map((h) => `${h.name}: ${h.description}`)
    .join('\n');

  const systemPrompt = `You are a memory retrieval assistant. Given a query and a list of available memory entries, select up to 5 entries that are most relevant to the query.

Each memory entry has a name and description. Return the names of the most relevant entries.

Available memories:
${manifest}`;

  const response = await sideQuery({
    model: RETRIEVAL_MODEL,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Query: ${query}\n\nSelect the most relevant memories (up to 5). Return JSON: { "selected_memories": ["name1", "name2", ...] }`,
      },
    ],
    maxTokens: 512,
    signal,
  });

  // Extract selection from response
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  try {
    const jsonStr = extractJson(textBlock.text);
    const parsed = selectedMemoriesSchema.parse(JSON.parse(jsonStr));

    // Load full entries for selected names
    const entries: MemoryEntry[] = [];
    for (const name of parsed.selected_memories) {
      const entry = await store.loadEntry(name);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    // If LLM response doesn't parse, return empty
    return [];
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match?.[1]) return match[1].trim();
  const objMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (objMatch?.[1]) return objMatch[1];
  return trimmed;
}
