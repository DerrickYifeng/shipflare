import { describe, expect, it } from 'vitest';
import {
  discoveryReviewerOutputSchema,
  discoveryReviewerJudgmentSchema,
} from '../schema';

describe('discoveryReviewerOutputSchema', () => {
  it('accepts a well-formed judgment list + notes', () => {
    const parsed = discoveryReviewerOutputSchema.safeParse({
      judgments: [
        {
          externalId: 'tweet-1',
          verdict: 'skip',
          confidence: 0.85,
          reasoning:
            'Author bio reads "growth marketer teaching you to sell courses" — outside product ICP.',
        },
        {
          externalId: 'tweet-2',
          verdict: 'queue',
          confidence: 0.9,
          reasoning:
            'Solo founder literally asks for a zapier-style alternative for SaaS distribution.',
        },
      ],
      notes: 'batch was 90% noise — consider narrowing sources',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts empty judgments for the "nothing to judge" case', () => {
    const parsed = discoveryReviewerOutputSchema.safeParse({
      judgments: [],
      notes: 'caller provided no threads',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects verdict values outside the queue/skip enum', () => {
    const parsed = discoveryReviewerJudgmentSchema.safeParse({
      externalId: '1',
      verdict: 'maybe',
      confidence: 0.5,
      reasoning: 'r',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects confidence out of 0..1', () => {
    const base = {
      externalId: '1',
      verdict: 'skip' as const,
      reasoning: 'r',
    };
    expect(
      discoveryReviewerJudgmentSchema.safeParse({ ...base, confidence: 1.1 })
        .success,
    ).toBe(false);
    expect(
      discoveryReviewerJudgmentSchema.safeParse({ ...base, confidence: -0.01 })
        .success,
    ).toBe(false);
  });

  it('requires non-empty reasoning', () => {
    const parsed = discoveryReviewerJudgmentSchema.safeParse({
      externalId: '1',
      verdict: 'skip',
      confidence: 0.5,
      reasoning: '',
    });
    expect(parsed.success).toBe(false);
  });
});
