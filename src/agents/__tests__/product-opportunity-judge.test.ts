import { describe, it, expect } from 'vitest';
import { productOpportunityJudgeOutputSchema } from '../schemas';

describe('productOpportunityJudgeOutputSchema', () => {
  it('accepts a green-light verdict with reason', () => {
    const parsed = productOpportunityJudgeOutputSchema.parse({
      allowMention: true,
      signal: 'tool_question',
      confidence: 0.8,
      reason: 'OP explicitly asks what stack to use',
    });
    expect(parsed.allowMention).toBe(true);
    expect(parsed.signal).toBe('tool_question');
  });

  it('accepts a hard-mute with reason', () => {
    const parsed = productOpportunityJudgeOutputSchema.parse({
      allowMention: false,
      signal: 'vulnerable_post',
      confidence: 0.95,
      reason: 'author sharing grief over first churn',
    });
    expect(parsed.allowMention).toBe(false);
  });

  it('rejects an invalid signal', () => {
    expect(() =>
      productOpportunityJudgeOutputSchema.parse({
        allowMention: true,
        signal: 'whatever',
        confidence: 0.5,
        reason: 'x',
      }),
    ).toThrow();
  });

  it('clamps confidence to 0..1', () => {
    expect(() =>
      productOpportunityJudgeOutputSchema.parse({
        allowMention: true,
        signal: 'tool_question',
        confidence: 1.5,
        reason: 'x',
      }),
    ).toThrow();
  });
});
