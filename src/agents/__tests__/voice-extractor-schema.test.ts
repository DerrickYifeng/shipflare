import { describe, it, expect } from 'vitest';
import { voiceExtractorOutputSchema } from '../schemas';

describe('voiceExtractorOutputSchema', () => {
  it('accepts a filled-out extraction', () => {
    const parsed = voiceExtractorOutputSchema.parse({
      styleCardMd: '# Style\n- sentence length: short\n- banned: words here',
      detectedBannedWords: ['leverage', 'delve'],
      topBigrams: [['shipped', 'today'], ['build', 'public']],
      avgSentenceLength: 9.4,
      lengthHistogram: { '0-50': 4, '50-100': 12, '100-150': 9, '150-200': 3, '200-280': 2 },
      openerHistogram: { 'just_shipped': 7, 'til': 3, 'naked_claim': 12 },
      confidence: 0.8,
    });
    expect(parsed.avgSentenceLength).toBeGreaterThan(0);
  });

  it('rejects a missing styleCardMd', () => {
    expect(() =>
      voiceExtractorOutputSchema.parse({
        detectedBannedWords: [],
        topBigrams: [],
        avgSentenceLength: 10,
        lengthHistogram: {},
        openerHistogram: {},
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('caps styleCardMd length at 4000', () => {
    const huge = 'a'.repeat(10000);
    expect(() =>
      voiceExtractorOutputSchema.parse({
        styleCardMd: huge,
        detectedBannedWords: [],
        topBigrams: [],
        avgSentenceLength: 10,
        lengthHistogram: {},
        openerHistogram: {},
        confidence: 0.5,
      }),
    ).toThrow();
  });
});
