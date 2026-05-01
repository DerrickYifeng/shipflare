import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(
  __dirname,
  '..',  // -> src/skills/_demo-echo-fork
);

describe('_demo-echo-fork', () => {
  it('loads with context: fork', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('_demo-echo-fork');
    expect(skill!.context).toBe('fork');
    expect(skill!.maxTurns).toBe(2);
  });

  it('body contains the echo template with mode: forked', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand('test', fakeCtx);
    expect(body).toContain('args: test');
    expect(body).toContain('mode: forked');
  });
});
