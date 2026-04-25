import { describe, expect, it } from 'vitest';
import {
  discoveryScoutOutputSchema,
  discoveryScoutVerdictSchema,
} from '../schema';

describe('discoveryScoutOutputSchema', () => {
  it('accepts a well-formed verdict list + notes', () => {
    const parsed = discoveryScoutOutputSchema.safeParse({
      verdicts: [
        {
          externalId: '123',
          platform: 'x',
          url: 'https://x.com/a/status/123',
          title: null,
          body: 'tweet body',
          author: 'alice',
          verdict: 'queue',
          confidence: 0.9,
          reason: 'solo founder with clear pain point',
        },
        {
          externalId: 't3_abc',
          platform: 'reddit',
          url: 'https://reddit.com/r/SaaS/comments/abc',
          title: 'how to get first users?',
          body: 'bootstrapped, ran out of ideas',
          author: 'u/bob',
          verdict: 'skip',
          confidence: 0.3,
          reason: 'thread resolved in replies',
        },
      ],
      notes: 'mixed sweep, 1 queued, 1 skipped',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts empty verdicts (legitimate cold-start outcome)', () => {
    const parsed = discoveryScoutOutputSchema.safeParse({
      verdicts: [],
      notes: 'every candidate was a competitor repost chain',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown platforms', () => {
    const parsed = discoveryScoutVerdictSchema.safeParse({
      externalId: '1',
      platform: 'linkedin',
      url: 'x',
      title: null,
      body: null,
      author: null,
      verdict: 'queue',
      confidence: 0.5,
      reason: 'r',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects confidence out of 0..1 range', () => {
    const base = {
      externalId: '1',
      platform: 'x' as const,
      url: 'u',
      title: null,
      body: null,
      author: null,
      verdict: 'queue' as const,
      reason: 'r',
    };
    expect(
      discoveryScoutVerdictSchema.safeParse({ ...base, confidence: 1.5 })
        .success,
    ).toBe(false);
    expect(
      discoveryScoutVerdictSchema.safeParse({ ...base, confidence: -0.1 })
        .success,
    ).toBe(false);
  });

  it('rejects unknown verdict values', () => {
    const parsed = discoveryScoutVerdictSchema.safeParse({
      externalId: '1',
      platform: 'x',
      url: 'u',
      title: null,
      body: null,
      author: null,
      verdict: 'maybe',
      confidence: 0.5,
      reason: 'r',
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a non-empty reason', () => {
    const parsed = discoveryScoutVerdictSchema.safeParse({
      externalId: '1',
      platform: 'x',
      url: 'u',
      title: null,
      body: null,
      author: null,
      verdict: 'queue',
      confidence: 0.5,
      reason: '',
    });
    expect(parsed.success).toBe(false);
  });
});
