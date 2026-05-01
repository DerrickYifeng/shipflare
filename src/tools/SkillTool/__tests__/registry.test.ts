import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
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

describe('FS watcher', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    __resetRegistryForTesting();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-watcher-'));
    await fs.mkdir(path.join(tmpRoot, 'a-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'a-skill', 'SKILL.md'),
      `---
name: a-skill
description: First version.
---

# Body v1
`,
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reflects file edits after debounce', async () => {
    __setSkillsRootForTesting(tmpRoot);
    const first = await getAllSkills();
    expect(first.find((s) => s.name === 'a-skill')?.description).toBe('First version.');

    // Edit the skill file.
    await fs.writeFile(
      path.join(tmpRoot, 'a-skill', 'SKILL.md'),
      `---
name: a-skill
description: Second version.
---

# Body v2
`,
      'utf8',
    );

    // Wait past the watcher debounce (200ms) + a small buffer.
    await new Promise((r) => setTimeout(r, 350));

    const second = await getAllSkills();
    expect(second.find((s) => s.name === 'a-skill')?.description).toBe('Second version.');
  });
});
