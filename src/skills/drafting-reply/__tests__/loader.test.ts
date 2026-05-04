import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

describe('drafting-reply loader', () => {
  it('inlines shared slop-rules into the system prompt', async () => {
    const dir = path.resolve(process.cwd(), 'src/skills/drafting-reply');
    const cmd = await loadSkill(dir);
    expect(cmd).not.toBeNull();
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const prompt = await cmd!.getPromptForCommand('', fakeCtx);
    // From slop-rules.md — banned-vocabulary section
    expect(prompt).toContain('banned_vocabulary');
    expect(prompt).toContain('preamble_opener');
  });
});
