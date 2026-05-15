import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('validating-draft loader', () => {
  it('exposes platform-specific rule routing in the system prompt', async () => {
    const cmd = await loadSkill(SKILL_DIR);
    expect(cmd).not.toBeNull();
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const prompt = await cmd!.getPromptForCommand('', fakeCtx);
    // Both per-platform rule files are referenced so the validator can route
    // by the input draft's `platform` field.
    expect(prompt).toContain('x-review-rules');
    expect(prompt).toContain('reddit-review-rules');
  });

  it('inlines reddit-review-rules content when loaded', async () => {
    const cmd = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const prompt = await cmd!.getPromptForCommand('', fakeCtx);
    // Sanity-check: the Reddit-specific REJECT bucket lands in the prompt so
    // the validator actually applies the rules instead of just naming them.
    expect(prompt).toContain('AutoMod red flags');
    expect(prompt).toContain('Banned slop phrases (Reddit-specific)');
  });
});
