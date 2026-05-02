import { describe, it, expect } from 'vitest';
import { draftingReplyInputSchema, draftingReplyOutputSchema } from '../schema';

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
