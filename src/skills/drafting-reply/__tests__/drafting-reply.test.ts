import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { draftingReplyInputSchema, draftingReplyOutputSchema } from '../schema';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('drafting-reply schema', () => {
  it('accepts a valid input shape', () => {
    expect(() =>
      draftingReplyInputSchema.parse({
        thread: {
          title: 'launching this Tuesday',
          body: 'here is the screenshot of the dashboard',
          author: 'someone',
          platform: 'x',
          community: 'x',
        },
        product: { name: 'ShipFlare', description: 'AI growth' },
        channel: 'x',
      }),
    ).not.toThrow();
  });

  it('rejects unknown channel', () => {
    expect(() =>
      draftingReplyInputSchema.parse({
        thread: { title: 't', body: '', author: 'a', platform: 'x', community: 'x' },
        product: { name: 'ShipFlare', description: 'AI' },
        channel: 'instagram',
      }),
    ).toThrow();
  });

  it('output shape includes draftBody, whyItWorks, confidence', () => {
    const parsed = draftingReplyOutputSchema.parse({
      draftBody: 'we shipped revenue analytics yesterday — first user spotted a $1,247 leak in 4 minutes.',
      whyItWorks: 'first-person anchor + specific number',
      confidence: 0.85,
    });
    expect(parsed.confidence).toBeGreaterThan(0.8);
  });
});

describe('drafting-reply skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('drafting-reply');
    expect(skill!.context).toBe('fork');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('produces a body referencing both channel voice files', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    expect(body).toContain('x-reply-voice');
    expect(body).toContain('reddit-reply-voice');
  });
});
