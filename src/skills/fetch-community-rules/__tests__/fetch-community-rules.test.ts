import { describe, it, expect } from 'vitest';
import { communityRulesOutputSchema } from '@/agents/schemas';

describe('communityRulesOutputSchema', () => {
  it('accepts a restricted-policy classification', () => {
    const valid = {
      community: 'SideProject',
      rulesRaw: [
        'Self-promotion allowed in the Saturday Showcase thread only.',
        'Be respectful and constructive.',
      ],
      selfPromotionPolicy: 'restricted',
      keyConstraints: [
        'self-promo only in Saturday Showcase thread',
        'be respectful',
      ],
      recommendation:
        "Self-promotion is allowed under the Saturday Showcase rule. Post ShipFlare updates there; elsewhere only reply when it's a real answer.",
    };
    expect(() => communityRulesOutputSchema.parse(valid)).not.toThrow();
  });

  it('accepts an unknown policy with empty rulesRaw', () => {
    const valid = {
      community: 'indiehackers',
      rulesRaw: [],
      selfPromotionPolicy: 'unknown',
      keyConstraints: [],
      recommendation:
        'Could not read community rules. Treat as restricted by default.',
    };
    expect(() => communityRulesOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects an unknown policy bucket value', () => {
    const invalid = {
      community: 'x',
      rulesRaw: [],
      selfPromotionPolicy: 'partial',
      keyConstraints: [],
      recommendation: 'r',
    };
    expect(() => communityRulesOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects more than 8 keyConstraints', () => {
    const invalid = {
      community: 'x',
      rulesRaw: [],
      selfPromotionPolicy: 'tolerated',
      keyConstraints: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      recommendation: 'r',
    };
    expect(() => communityRulesOutputSchema.parse(invalid)).toThrow();
  });
});
