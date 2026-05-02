import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgent } from '@/tools/AgentTool/loader';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('loader — Phase A restored fields', () => {
  it('parses disallowedTools as a string array', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    expect(agent.disallowedTools).toEqual(['SendMessage']);
  });

  it('defaults disallowedTools to [] when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.disallowedTools).toEqual([]);
  });
});
