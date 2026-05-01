import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  registerBundledSkill,
  getAllSkills,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('registerBundledSkill', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
  });

  it('registers a bundled skill that getAllSkills returns', async () => {
    registerBundledSkill({
      name: 'bundled-test',
      description: 'A bundled skill for tests.',
      getPromptForCommand: () => 'bundled body',
    });
    __setSkillsRootForTesting(FIXTURES);

    const all = await getAllSkills();
    const names = all.map((s) => s.name);
    expect(names).toContain('bundled-test');
  });

  it('bundled skill wins on name conflict with file skill', async () => {
    registerBundledSkill({
      name: 'valid-skill',  // collides with fixtures/valid-skill/
      description: 'Bundled override.',
      getPromptForCommand: () => 'override',
    });
    __setSkillsRootForTesting(FIXTURES);

    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'valid-skill');
    expect(skill?.source).toBe('bundled');
    expect(skill?.description).toBe('Bundled override.');
  });

  it('bundled skill default context is "inline"', async () => {
    registerBundledSkill({
      name: 'bundled-default',
      description: 'no context declared',
      getPromptForCommand: () => 'x',
    });
    __setSkillsRootForTesting(FIXTURES);
    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'bundled-default');
    expect(skill?.context).toBe('inline');
    expect(skill?.allowedTools).toEqual([]);
  });
});
