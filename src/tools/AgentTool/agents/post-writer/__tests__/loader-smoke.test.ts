// Smoke test: the post-writer AGENT.md (+ references) loads via the
// canonical loader path with both platform guides + content-safety
// inlined. This protects the cleanup phase that merged x-writer +
// reddit-writer into a single channel-aware writer.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('post-writer loader smoke', () => {
  it('loads post-writer with X + Reddit + safety references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    expect(names).toContain('post-writer');

    const writer = agents.find((a) => a.name === 'post-writer');
    expect(writer).toBeDefined();
    if (!writer) return;

    expect(writer.tools).toEqual([
      'draft_post',
      'validate_draft',
      'SendMessage',
      'StructuredOutput',
    ]);
    expect(writer.model).toBe('claude-haiku-4-5-20251001');
    expect(writer.maxTurns).toBe(4);

    // Both platform guides inlined under the loader's "## <name>" header.
    expect(writer.systemPrompt).toContain('## x-content-guide');
    expect(writer.systemPrompt).toContain('280 weighted chars per tweet');
    expect(writer.systemPrompt).toContain('## reddit-content-guide');
    expect(writer.systemPrompt).toContain('Target: 150–600 words');
    expect(writer.systemPrompt).toContain('## content-safety');
    expect(writer.systemPrompt).toContain(
      'Numeric claims require a real citation',
    );
  });

  it('the legacy x-writer + reddit-writer agents are gone', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = new Set(agents.map((a) => a.name));
    expect(names.has('x-writer')).toBe(false);
    expect(names.has('reddit-writer')).toBe(false);
  });
});
