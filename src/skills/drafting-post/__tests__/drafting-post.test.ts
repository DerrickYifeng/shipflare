import { describe, it, expect } from 'vitest';
import { draftingPostInputSchema, draftingPostOutputSchema } from '../schema';

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
