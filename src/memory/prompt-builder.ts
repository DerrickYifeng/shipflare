import { MemoryStore } from './store';
import { findRelevantMemories } from './retrieval';

/**
 * Build the static memory prompt block for agent system prompts.
 * Includes the memory index + recall guidance.
 *
 * Ported from engine/memdir/memdir.ts buildMemoryPrompt,
 * with MEMORY_DRIFT_CAVEAT and TRUSTING_RECALL_SECTION from engine/memdir/memoryTypes.ts.
 */
export async function buildMemoryPrompt(store: MemoryStore): Promise<string> {
  const index = await store.loadIndex();

  if (!index) return '';

  return [
    '<agent-memory>',
    '## Product Knowledge',
    'The following memories contain knowledge accumulated from past agent runs for this product.',
    'Use this context to make better decisions. Do not repeat past mistakes noted in feedback memories.',
    '',
    index,
    '',
    '## Using These Memories',
    '',
    'Memory records can become stale over time. A memory that says "r/SaaS yields high-relevance threads"',
    'was true when the memory was written — the subreddit may have changed rules, shifted focus, or become',
    'less active since then. If observations from the current run contradict a memory, trust what you observe',
    'now. The current run\'s data is always more authoritative than stored memories.',
    '',
    'Before relying on a memory to make decisions:',
    '- If a memory claims a subreddit performs well, verify against current discovery results',
    '- If a memory recommends a content strategy, check whether recent confidence scores support it',
    '- If a memory names a specific pattern ("solo founders respond to X"), apply it but note if results differ',
    '',
    'Feedback memories (strategy guidance) carry the most weight — they encode validated lessons.',
    'Project memories (operational patterns) decay fastest — verify before assuming.',
    '</agent-memory>',
  ].join('\n');
}

/**
 * Load query-relevant memories for on-demand context injection.
 * Called during agent execution when the agent needs specific memories.
 *
 * Ported from engine/memdir/memdir.ts buildMemoryLines.
 */
export async function loadRelevantContext(
  query: string,
  store: MemoryStore,
  signal: AbortSignal,
): Promise<string> {
  const entries = await findRelevantMemories(query, store, signal);

  if (entries.length === 0) return '';

  const blocks = entries.map((e) =>
    `### ${e.name} (${e.type})\n${e.description}\n\n${e.content}`,
  );

  return [
    '<relevant-memories>',
    ...blocks,
    '</relevant-memories>',
  ].join('\n');
}
