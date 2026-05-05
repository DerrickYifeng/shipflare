import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { draftingPostInputSchema, draftingPostOutputSchema } from '../schema';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('drafting-post schema', () => {
  it('accepts a valid input shape with planItem + product + channel + phase', () => {
    expect(() =>
      draftingPostInputSchema.parse({
        planItem: {
          id: 'pi-1',
          title: 'Day 12: shipping the pricing page',
          description: '',
          channel: 'x',
          params: {},
        },
        product: { name: 'ShipFlare', description: 'AI growth' },
        channel: 'x',
        phase: 'foundation',
      }),
    ).not.toThrow();
  });

  it('rejects unknown phase', () => {
    expect(() =>
      draftingPostInputSchema.parse({
        planItem: { id: 'pi-1', title: 't', channel: 'x', params: {} },
        product: { name: 'p', description: 'd' },
        channel: 'x',
        phase: 'invented',
      }),
    ).toThrow();
  });

  it('output shape includes draftBody, whyItWorks, confidence', () => {
    const parsed = draftingPostOutputSchema.parse({
      draftBody: 'shipped revenue analytics yesterday — first user spotted a $1,247 leak in 4 minutes.',
      whyItWorks: 'foundation-phase first-revenue-style update with first-person anchor',
      confidence: 0.85,
    });
    expect(parsed.confidence).toBeGreaterThan(0.8);
  });
});

describe('drafting-post skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('drafting-post');
    expect(skill!.context).toBe('fork');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('produces a body referencing both channel voice files', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    expect(body).toContain('x-post-voice');
    expect(body).toContain('reddit-post-voice');
    expect(body).toContain('content-safety');
  });
});
