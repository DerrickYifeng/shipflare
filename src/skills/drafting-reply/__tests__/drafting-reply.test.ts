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

  it('accepts the Reddit safe-skip output shape (empty body + flagged)', () => {
    // When `get_subreddit_rules` returns a rule like "no self-promotion",
    // the drafter emits an empty body + `flagged: true`. The schema MUST
    // round-trip this — gating empty `draftBody` would crash the safe-skip
    // path that's supposed to degrade gracefully.
    const parsed = draftingReplyOutputSchema.parse({
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
    const parsed = draftingReplyOutputSchema.parse({
      draftBody: 'we shipped revenue analytics yesterday.',
      whyItWorks: 'first-person anchor + specific number',
      confidence: 0.7,
    });
    expect(parsed.flagged).toBeUndefined();
    expect(parsed.flagReason).toBeUndefined();
  });

  it('accepts thread with conversation-context fields populated', () => {
    const parsed = draftingReplyInputSchema.parse({
      thread: {
        title: 'marketing has been the biggest frustration',
        body: 'tried Apple Search Ads, Meta, SEO, influencers',
        author: 'anumness',
        platform: 'x',
        community: 'x',
        quotedText: 'OMG this actually worked — database is complete',
        quotedAuthor: 'anumness',
        inReplyToText: null,
        inReplyToAuthor: null,
      },
      product: { name: 'ShipFlare', description: 'AI growth' },
      channel: 'x',
    });
    // Load-bearing: verify the fields actually round-trip through the schema.
    expect(parsed.thread.quotedText).toBe('OMG this actually worked — database is complete');
    expect(parsed.thread.quotedAuthor).toBe('anumness');
    expect(parsed.thread.inReplyToText).toBeNull();
    expect(parsed.thread.inReplyToAuthor).toBeNull();
  });

  it('accepts thread with all conversation fields null', () => {
    const parsed = draftingReplyInputSchema.parse({
      thread: {
        title: 't',
        body: 'b',
        author: 'a',
        platform: 'x',
        community: 'x',
        quotedText: null,
        quotedAuthor: null,
        inReplyToText: null,
        inReplyToAuthor: null,
      },
      product: { name: 'ShipFlare', description: 'AI' },
      channel: 'x',
    });
    expect(parsed.thread.quotedText).toBeNull();
    expect(parsed.thread.quotedAuthor).toBeNull();
    expect(parsed.thread.inReplyToText).toBeNull();
    expect(parsed.thread.inReplyToAuthor).toBeNull();
  });

  it('accepts thread without conversation fields at all (back-compat)', () => {
    expect(() =>
      draftingReplyInputSchema.parse({
        thread: {
          title: 't',
          body: 'b',
          author: 'a',
          platform: 'x',
          community: 'x',
        },
        product: { name: 'ShipFlare', description: 'AI' },
        channel: 'x',
      }),
    ).not.toThrow();
  });
});

describe('drafting-reply skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('drafting-reply');
    expect(skill!.context).toBe('fork');
    // get_subreddit_rules: drafting fetches sub-specific norms (no
    // self-promo, no AI tools) before drafting Reddit replies. See
    // SKILL.md "Reddit-specific drafting" section.
    expect(skill!.allowedTools).toEqual(['get_subreddit_rules']);
  });

  it('produces a body referencing both channel voice files', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    expect(body).toContain('x-reply-voice');
    expect(body).toContain('reddit-reply-voice');
  });

  it('SKILL.md body documents conversation-context inputs and self-audit', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    // Inputs section mentions both new field families.
    expect(body).toContain('quotedText');
    expect(body).toContain('inReplyToText');
    // Self-audit step 6 added.
    expect(body).toContain('Context-awareness check');
  });
});
