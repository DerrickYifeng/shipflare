import { beforeEach, describe, expect, it } from 'vitest';
import { validateReplyLength } from '../length';

describe('validateReplyLength', () => {
  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
  });

  it('passes text under the X reply cap (240)', () => {
    const r = validateReplyLength('hi there', { platform: 'x', kind: 'reply' });
    expect(r.ok).toBe(true);
    expect(r.excess).toBeUndefined();
    expect(r.limit).toBe(240);
    expect(r.length).toBe('hi there'.length);
  });

  it('passes text at exactly the X reply cap', () => {
    const r = validateReplyLength('a'.repeat(240), { platform: 'x', kind: 'reply' });
    expect(r.ok).toBe(true);
    expect(r.length).toBe(240);
  });

  it('fails text one over the X reply cap and reports excess', () => {
    const r = validateReplyLength('a'.repeat(241), { platform: 'x', kind: 'reply' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_long');
    expect(r.excess).toBe(1);
    expect(r.limit).toBe(240);
    expect(r.length).toBe(241);
  });

  it('uses the post cap (280) for post kind', () => {
    const r = validateReplyLength('a'.repeat(281), { platform: 'x', kind: 'post' });
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(280);
    expect(r.excess).toBe(1);
  });

  it('counts emoji as one character (code-point aware)', () => {
    // Single astral emoji renders as 2 JS "chars" but 1 code point.
    const r = validateReplyLength('a'.repeat(239) + '\uD83D\uDE80', {
      platform: 'x',
      kind: 'reply',
    });
    expect(r.ok).toBe(true);
    expect(r.length).toBe(240);
  });

  it('uses reddit post cap of 40,000', () => {
    const r = validateReplyLength('a'.repeat(40_001), {
      platform: 'reddit',
      kind: 'post',
    });
    expect(r.ok).toBe(false);
    expect(r.limit).toBe(40_000);
  });

  it('throws on an unknown platform (fail loud, not silent)', () => {
    expect(() =>
      validateReplyLength('x', { platform: 'linkedin', kind: 'post' }),
    ).toThrow(/Unknown platform/);
  });
});
