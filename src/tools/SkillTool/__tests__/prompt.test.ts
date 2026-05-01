import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';
import { renderSkillRoster } from '@/tools/SkillTool/prompt';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('renderSkillRoster', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  it('lists every skill name + description', async () => {
    registerBundledSkill({
      name: 'bundled-x',
      description: 'A bundled fixture skill.',
      getPromptForCommand: () => 'x',
    });
    __setSkillsRootForTesting(FIXTURES);

    const roster = await renderSkillRoster();
    expect(roster).toContain('bundled-x');
    expect(roster).toContain('A bundled fixture skill.');
    expect(roster).toContain('valid-skill');
  });

  it('includes when-to-use hint when present', async () => {
    registerBundledSkill({
      name: 'with-hint',
      description: 'A skill.',
      whenToUse: 'Pick when X happens.',
      getPromptForCommand: () => 'x',
    });
    __setSkillsRootForTesting(FIXTURES);

    const roster = await renderSkillRoster();
    expect(roster).toContain('Pick when X happens.');
  });

  it('returns empty-state message when no skills registered', async () => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting('/nonexistent');
    const roster = await renderSkillRoster();
    expect(roster).toMatch(/no skills (registered|available)/i);
  });
});
