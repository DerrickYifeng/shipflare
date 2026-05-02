import { describe, it, expect } from 'vitest';
import { judgingOpportunityInputSchema, judgingOpportunityOutputSchema } from '../schema';

describe('judging-opportunity schema', () => {
  it('accepts a thread + product + platform input', () => {
    expect(() =>
      judgingOpportunityInputSchema.parse({
        thread: {
          title: 't',
          body: 'b',
          author: 'a',
          platform: 'x',
          community: 'x',
          upvotes: 0,
          commentCount: 0,
          postedAt: new Date().toISOString(),
        },
        product: { name: 'p', description: 'd' },
        platform: 'x',
      }),
    ).not.toThrow();
  });

  it('output names which gate failed when pass=false', () => {
    const parsed = judgingOpportunityOutputSchema.parse({
      pass: false,
      gateFailed: 1,
      canMentionProduct: false,
      signal: 'competitor',
      rationale: 'OP is shilling their own tool',
    });
    expect(parsed.gateFailed).toBe(1);
  });

  it('rejects invalid gateFailed values', () => {
    expect(() =>
      judgingOpportunityOutputSchema.parse({
        pass: false,
        gateFailed: 4,
        canMentionProduct: false,
        signal: 'x',
        rationale: 'y',
      }),
    ).toThrow();
  });
});
