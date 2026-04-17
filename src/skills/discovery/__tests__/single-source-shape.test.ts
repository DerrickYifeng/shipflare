import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('discovery skill single-source', () => {
  it('SKILL.md declares single source input (not sources[])', () => {
    const md = readFileSync('src/skills/discovery/SKILL.md', 'utf8');
    expect(md).toMatch(/\bsource:\s*string/);
    expect(md).not.toMatch(/\bsources:\s*string\[\]/);
  });
  it('agent prompt does not fan out across sources', () => {
    const md = readFileSync('src/agents/discovery.md', 'utf8');
    expect(md.toLowerCase()).not.toMatch(/for each (source|subreddit)/);
  });
});
