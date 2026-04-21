// Smoke test: the x-writer AGENT.md (+ references) loads via the
// canonical loader path with references inlined.
//
// This protects the Phase E Day 1 landing: the tool's registration,
// the AGENT.md frontmatter shape, and the references/ files on disk
// must all line up. Uses the production shared-references dir so a
// typo in `references:` surfaces here, not at runtime.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('x-writer loader smoke', () => {
  it('loads x-writer from loadAgentsDir with references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    expect(names).toContain('x-writer');

    const xWriter = agents.find((a) => a.name === 'x-writer');
    expect(xWriter).toBeDefined();
    if (!xWriter) return;

    // Tools allowlist matches spec §9.4.
    expect(xWriter.tools).toEqual([
      'draft_post',
      'SendMessage',
      'StructuredOutput',
    ]);
    expect(xWriter.model).toBe('claude-haiku-4-5-20251001');
    expect(xWriter.maxTurns).toBe(4);

    // Per-agent references inlined with the loader's "## <name>" header.
    expect(xWriter.systemPrompt).toContain('## x-content-guide');
    expect(xWriter.systemPrompt).toContain('280 characters MAX per tweet');
    expect(xWriter.systemPrompt).toContain('## content-safety');
    expect(xWriter.systemPrompt).toContain(
      'Numeric claims require a real citation',
    );
  });
});
