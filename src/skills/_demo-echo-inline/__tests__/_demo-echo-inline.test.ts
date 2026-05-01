import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(
  __dirname,
  '..',  // -> src/skills/_demo-echo-inline
);

describe('_demo-echo-inline', () => {
  it('loads from disk', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('_demo-echo-inline');
    expect(skill!.context).toBe('inline');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('produces a body containing ECHO_START / ECHO_END', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand('hello world', fakeCtx);
    expect(body).toContain('ECHO_START');
    expect(body).toContain('args: hello world');
    expect(body).toContain('mode: inline');
    expect(body).toContain('ECHO_END');
  });

  it('references the format reference file', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand('', fakeCtx);
    expect(body).toContain('references/format.md');
  });
});
