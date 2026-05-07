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

  it('accepts the Reddit safe-skip output shape (empty body + flagged)', () => {
    // When `get_subreddit_rules` returns a rule like "no self-promotion",
    // the drafter emits an empty body + `flagged: true`. The schema MUST
    // round-trip this — gating empty `draftBody` would crash the safe-skip
    // path that's supposed to degrade gracefully.
    const parsed = draftingPostOutputSchema.parse({
      draftBody: '',
      whyItWorks: 'No Self-Promotion',
      confidence: 0.0,
      flagged: true,
      flagReason: 'subreddit rule conflict',
    });
    expect(parsed.draftBody).toBe('');
    expect(parsed.flagged).toBe(true);
    expect(parsed.flagReason).toBe('subreddit rule conflict');
  });

  it('flagged + flagReason remain optional for normal drafts', () => {
    const parsed = draftingPostOutputSchema.parse({
      draftBody: 'shipped the pricing page tonight, $47 MRR.',
      whyItWorks: 'foundation-phase milestone with first-person anchor',
      confidence: 0.7,
    });
    expect(parsed.flagged).toBeUndefined();
    expect(parsed.flagReason).toBeUndefined();
  });
});

describe('drafting-post skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('drafting-post');
    expect(skill!.context).toBe('fork');
    // get_subreddit_rules: drafting fetches sub-specific norms (no
    // self-promo, no AI tools) before drafting Reddit posts. See
    // SKILL.md "Reddit-specific drafting" section.
    expect(skill!.allowedTools).toEqual(['get_subreddit_rules']);
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
