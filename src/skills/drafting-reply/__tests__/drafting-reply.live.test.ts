/**
 * Live LLM canary for the conversation-context feature.
 *
 * Calls the real Sonnet drafting-reply fork with a synthetic thread that
 * carries quotedText (the Anum-style self-quote pattern from the spec).
 * Asserts the resulting draftBody references the quoted post — proves
 * the SKILL.md + x-reply-voice.md prompt changes actually shift drafter
 * behavior, not just compile.
 *
 * Skipped unless LIVE_LLM=1 is set (CI runs without it; local pre-merge
 * verification runs with it). Also requires ANTHROPIC_API_KEY in env.
 *
 * Run with:
 *   LIVE_LLM=1 pnpm vitest run src/skills/drafting-reply/__tests__/drafting-reply.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { runForkSkill } from '@/skills/run-fork-skill';
import { draftingReplyOutputSchema } from '../schema';

const LIVE = process.env.LIVE_LLM === '1';

describe.skipIf(!LIVE)('drafting-reply LIVE: conversation context', () => {
  it('writes a draft that references the quoted post (self-quote pattern)', async () => {
    const args = {
      thread: {
        title: 'marketing has been the biggest frustration',
        body: 'Marketing has been by far the biggest frigging frustration of being an indie dev. Tried Apple Search ads — broke even. Tried meta ads, lost money. Tried SEO, no results yet.',
        author: 'anumness',
        authorBio: 'building in public',
        authorFollowers: 1500,
        platform: 'x' as const,
        community: 'x',
        quotedText:
          'OMG this actually worked — the database is complete now so I told Claude to use it to make a video of most viral moments and the result is SHOCKINGLY AMAZING',
        quotedAuthor: 'anumness',
        inReplyToText: null,
        inReplyToAuthor: null,
      },
      product: {
        name: 'ShipFlare',
        description: 'AI marketing teammates for indie devs',
        valueProp: 'Ship without babysitting marketing',
      },
      channel: 'x' as const,
      canMentionProduct: false,
    };

    const { result } = await runForkSkill(
      'drafting-reply',
      JSON.stringify(args),
      draftingReplyOutputSchema,
      {},
    );
    const parsed = draftingReplyOutputSchema.parse(result);
    const lower = parsed.draftBody.toLowerCase();

    // The quoted post talks about: database, video, viral, claude, work(ed).
    // A context-aware draft should reference at least one of these tokens.
    // A draft that only discusses Apple Search / Meta / SEO (outer body)
    // is a regression — that's the bug we're fixing.
    const QUOTED_TOKENS = [
      'database',
      'video',
      'viral',
      'claude',
      'worked',
      'win',
    ];
    const referenced = QUOTED_TOKENS.find((t) => lower.includes(t));

    // eslint-disable-next-line no-console
    console.log(
      `[drafting-reply LIVE] draftBody=${JSON.stringify(parsed.draftBody)} referenced=${referenced ?? 'NONE'}`,
    );

    expect(
      referenced,
      `draftBody=${JSON.stringify(parsed.draftBody)} referenced no quoted-post tokens [${QUOTED_TOKENS.join(', ')}]`,
    ).toBeDefined();
  }, 60_000); // 60s timeout — Sonnet drafting can take 20-40s end-to-end
});
