import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('drafting-post loader', () => {
  it('inlines shared slop-rules into the system prompt', async () => {
    const cmd = await loadSkill(SKILL_DIR);
    expect(cmd).not.toBeNull();
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const prompt = await cmd!.getPromptForCommand('', fakeCtx);
    expect(prompt).toContain('banned_vocabulary');
    expect(prompt).toContain('diagnostic_from_above');
  });

  it('keeps the SKILL.md body Slop-rules meta-instruction header', async () => {
    const cmd = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const prompt = await cmd!.getPromptForCommand('', fakeCtx);
    expect(prompt).toContain('Slop rules — DO NOT EMIT THESE PATTERNS');
  });
});
