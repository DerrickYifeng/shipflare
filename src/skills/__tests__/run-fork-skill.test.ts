import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';
import { runForkSkill } from '../run-fork-skill';

describe('runForkSkill', () => {
  let tmpRoot: string;

  beforeEach(() => {
    __resetRegistryForTesting();
    tmpRoot = mkdtempSync(join(tmpdir(), 'shipflare-fork-skill-'));
    __setSkillsRootForTesting(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetRegistryForTesting();
  });

  it('throws when the skill is not registered', async () => {
    await expect(runForkSkill('does-not-exist', 'hello')).rejects.toThrow(
      /Unknown skill/,
    );
  });

  it('throws when the skill is inline-mode', async () => {
    const dir = join(tmpRoot, 'echo-inline');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: echo-inline
description: test
context: inline
---
body`,
    );

    await expect(runForkSkill('echo-inline', 'hi')).rejects.toThrow(
      /not fork-mode/,
    );
  });
});
