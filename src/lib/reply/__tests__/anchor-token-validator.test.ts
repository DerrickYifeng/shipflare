import { describe, it, expect } from 'vitest';
import { validateAnchorToken } from '../anchor-token-validator';

describe('validateAnchorToken', () => {
  it('accepts replies with a number', () => {
    expect(validateAnchorToken('took us 14 months to hit that').pass).toBe(true);
    expect(validateAnchorToken('$10k is the hard one').pass).toBe(true);
    expect(validateAnchorToken('20% lift same week').pass).toBe(true);
  });

  it('accepts replies with a proper noun (capitalized mid-sentence)', () => {
    expect(validateAnchorToken('postgres + drizzle. regretted every ORM that tried to be clever').pass).toBe(true);
    expect(validateAnchorToken('reminds me of what levelsio did with photoAI').pass).toBe(true);
  });

  it('accepts replies with a URL', () => {
    expect(validateAnchorToken('see https://example.com for context').pass).toBe(true);
  });

  it('accepts replies with a timestamp phrase', () => {
    expect(validateAnchorToken('last week the same thing happened').pass).toBe(true);
    expect(validateAnchorToken('month 8 for us too').pass).toBe(true);
  });

  it('rejects generic, anchor-free replies', () => {
    expect(validateAnchorToken('this is so great').pass).toBe(false);
    expect(validateAnchorToken('love where this is going').pass).toBe(false);
    expect(validateAnchorToken('agreed completely').pass).toBe(false);
  });

  it('returns the detected anchor tokens', () => {
    const result = validateAnchorToken('took us 14 months with postgres');
    expect(result.pass).toBe(true);
    expect(result.anchors).toEqual(expect.arrayContaining(['14', 'postgres']));
  });

  it('ignores sentence-initial capitalization as a proper noun', () => {
    expect(validateAnchorToken('They should know better').pass).toBe(false);
  });
});
