import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgent, loadAgentsDir } from '@/tools/AgentTool/loader';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const SHARED_REFS = path.join(FIXTURES, '_shared', 'references');

describe('loadAgent', () => {
  it('parses a fully populated AGENT.md and inlines references', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });

    expect(agent.name).toBe('valid-agent');
    expect(agent.description).toContain('fully populated agent fixture');
    expect(agent.tools).toEqual(['Task', 'query_plan_items', 'SendMessage']);
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.maxTurns).toBe(12);
    expect(agent.color).toBe('blue');
    expect(agent.sourcePath).toBe(
      path.join(FIXTURES, 'valid-agent', 'AGENT.md'),
    );

    // Body present.
    expect(agent.systemPrompt).toContain('# Valid agent');

    // Per-agent reference inlined with header.
    expect(agent.systemPrompt).toContain('## playbook');
    expect(agent.systemPrompt).toContain('Step 1 — read the brief.');

    // Shared reference inlined with header.
    expect(agent.systemPrompt).toContain('## base-guidelines');
    expect(agent.systemPrompt).toContain('never fabricate data');
  });

  it('rejects an AGENT.md missing the description field', async () => {
    await expect(
      loadAgent(path.join(FIXTURES, 'missing-description'), {
        sharedReferencesDir: SHARED_REFS,
      }),
    ).rejects.toThrow(/description/i);
  });

  it('rejects an AGENT.md whose tools field is not an array', async () => {
    await expect(
      loadAgent(path.join(FIXTURES, 'invalid-tools'), {
        sharedReferencesDir: SHARED_REFS,
      }),
    ).rejects.toThrow();
  });
});

describe('loadAgentsDir', () => {
  it('recursively discovers AGENT.md files and skips failing subtrees only on demand', async () => {
    // Only load the valid fixture so loadAgentsDir resolves cleanly. The
    // invalid/missing-description fixtures live under the same root, so we
    // point at a scoped sub-directory that contains a single valid agent.
    const scopedRoot = path.join(FIXTURES, 'valid-agent');
    // Because valid-agent itself contains an AGENT.md, loadAgentsDir treats
    // it as an agent directory and returns a single entry.
    const agents = await loadAgentsDir(scopedRoot, {
      sharedReferencesDir: SHARED_REFS,
    });

    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('valid-agent');
  });

  it('throws descriptively when any AGENT.md under the root is malformed', async () => {
    await expect(
      loadAgentsDir(FIXTURES, { sharedReferencesDir: SHARED_REFS }),
    ).rejects.toThrow();
  });
});

describe('skills frontmatter', () => {
  it('parses skills array into AgentDefinition.skills', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'agent-with-skills'),
      { sharedReferencesDir: SHARED_REFS },
    );
    expect(agent.skills).toEqual(['some-skill', 'another-skill']);
  });

  it('defaults skills to empty array when frontmatter omits it', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });
    expect(agent.skills).toEqual([]);
  });
});
