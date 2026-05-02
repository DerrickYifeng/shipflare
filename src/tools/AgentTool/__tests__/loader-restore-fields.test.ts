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

  it('parses background as a boolean', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    expect(agent.background).toBe(true);
  });

  it('defaults background to false when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.background).toBe(false);
  });

  it('parses role: member from explicit frontmatter', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    // The fixture sets role: member — assert that explicitly
    expect(agent.role).toBe('member');
  });

  it('defaults role to "member" when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.role).toBe('member');
  });

  it('rejects an invalid role value', async () => {
    await expect(
      loadAgent(path.join(FIXTURES, 'invalid-role'), {
        sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
      }),
    ).rejects.toThrow(/role/i);
  });
});
