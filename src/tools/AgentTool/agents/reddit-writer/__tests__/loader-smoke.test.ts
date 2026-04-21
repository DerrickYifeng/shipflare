// Smoke test: the reddit-writer AGENT.md (+ references) loads via the
// canonical loader path with references inlined.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('reddit-writer loader smoke', () => {
  it('loads reddit-writer from loadAgentsDir with references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    expect(names).toContain('reddit-writer');

    const redditWriter = agents.find((a) => a.name === 'reddit-writer');
    expect(redditWriter).toBeDefined();
    if (!redditWriter) return;

    expect(redditWriter.tools).toEqual([
      'draft_post',
      'SendMessage',
      'StructuredOutput',
    ]);
    expect(redditWriter.model).toBe('claude-haiku-4-5-20251001');
    expect(redditWriter.maxTurns).toBe(4);

    // Per-agent references inlined with the loader's "## <name>" header.
    expect(redditWriter.systemPrompt).toContain('## reddit-content-guide');
    expect(redditWriter.systemPrompt).toContain('Target: 150–600 words');
    expect(redditWriter.systemPrompt).toContain('## content-safety');
    expect(redditWriter.systemPrompt).toContain(
      'Numeric claims require a real citation',
    );
    // reddit-writer should NOT carry the X-only guide.
    expect(redditWriter.systemPrompt).not.toContain(
      '#buildinpublic on every post',
    );
  });

  it('reddit-writer and x-writer are distinct agent definitions', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const reddit = agents.find((a) => a.name === 'reddit-writer');
    const x = agents.find((a) => a.name === 'x-writer');
    expect(reddit).toBeDefined();
    expect(x).toBeDefined();
    // Bodies diverge on the platform-specific reference.
    expect(reddit?.systemPrompt).not.toEqual(x?.systemPrompt);
  });
});
