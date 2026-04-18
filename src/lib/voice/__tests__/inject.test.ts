import { describe, it, expect } from 'vitest';
import { buildVoiceBlock } from '../inject';
import type { VoiceProfileRow } from '../inject';

function fakeProfile(overrides: Partial<VoiceProfileRow> = {}): VoiceProfileRow {
  return {
    register: 'builder_log',
    pronouns: 'i',
    capitalization: 'sentence',
    emojiPolicy: 'sparing',
    signatureEmoji: null,
    punctuationSignatures: ['em_dash'],
    humorRegister: ['self_deprecating'],
    bannedWords: ['leverage', 'delve'],
    bannedPhrases: ['in today\u2019s fast-paced world'],
    worldviewTags: ['pro_craft'],
    openerPreferences: ['Just shipped\u2026'],
    closerPolicy: 'silent_stop',
    voiceStrength: 'moderate',
    extractedStyleCardMd: '# Voice\n- short sentences\n- never uses em-dash unprompted',
    sampleTweets: Array.from({ length: 15 }, (_, i) => ({
      id: `t${i}`,
      text: `sample tweet ${i} with some content`,
      engagement: 100 - i,
    })),
    ...overrides,
  };
}

describe('buildVoiceBlock', () => {
  it('returns null when profile is undefined', () => {
    expect(buildVoiceBlock(null)).toBeNull();
    expect(buildVoiceBlock(undefined)).toBeNull();
  });

  it('wraps output in <voice_profile> XML', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toMatch(/^<voice_profile>/);
    expect(block).toMatch(/<\/voice_profile>\s*$/);
  });

  it('includes the structured fields', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toContain('builder_log');
    expect(block).toContain('em_dash');
    expect(block).toContain('pro_craft');
  });

  it('includes the extracted style card markdown', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toContain('short sentences');
  });

  it('rotates 5 sample tweets per call (randomised)', () => {
    const profile = fakeProfile();
    const blockA = buildVoiceBlock(profile, { seed: 1 })!;
    const blockB = buildVoiceBlock(profile, { seed: 2 })!;
    expect(blockA).not.toBe(blockB);
    const countA = (blockA.match(/<example>/g) ?? []).length;
    expect(countA).toBe(5);
  });

  it('respects voiceStrength: strict → include bannedPhrases', () => {
    const block = buildVoiceBlock(fakeProfile({ voiceStrength: 'strict' }))!;
    expect(block).toContain('in today');
  });

  it('respects voiceStrength: loose → omit extractedStyleCardMd', () => {
    const block = buildVoiceBlock(fakeProfile({ voiceStrength: 'loose' }))!;
    expect(block).not.toContain('short sentences');
    expect(block).toContain('builder_log');
  });

  it('falls back gracefully when extractedStyleCardMd is null', () => {
    const block = buildVoiceBlock(fakeProfile({ extractedStyleCardMd: null }))!;
    expect(block).toBeTruthy();
    expect(block).toContain('builder_log');
  });

  it('emits an explicit "do not parrot examples verbatim" instruction', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toMatch(/do not (copy|parrot|repeat) (these|example)/i);
  });
});
