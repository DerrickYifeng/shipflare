import { beforeEach, describe, expect, it } from 'vitest';
import { validateReplyLength } from '../length';

describe('validateReplyLength', () => {
  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
  });

  describe('X — twitter-text weighted counting', () => {
    it('passes ASCII text under the X reply cap (280)', () => {
      const r = validateReplyLength('hi there', {
        platform: 'x',
        kind: 'reply',
      });
      expect(r.ok).toBe(true);
      expect(r.excess).toBe(0);
      expect(r.limit).toBe(280);
      expect(r.length).toBe('hi there'.length);
      expect(r.isThread).toBe(false);
      expect(r.segmentCount).toBe(1);
    });

    it('passes text at exactly the X cap', () => {
      const r = validateReplyLength('a'.repeat(280), {
        platform: 'x',
        kind: 'reply',
      });
      expect(r.ok).toBe(true);
      expect(r.length).toBe(280);
      expect(r.excess).toBe(0);
    });

    it('fails text one over the X cap and reports excess', () => {
      const r = validateReplyLength('a'.repeat(281), {
        platform: 'x',
        kind: 'reply',
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('too_long');
      expect(r.excess).toBe(1);
      expect(r.limit).toBe(280);
      expect(r.length).toBe(281);
    });

    it('counts URLs as exactly 23 chars (t.co accounting)', () => {
      const url = 'https://this-is-a-very-long-url.example.com/foo/bar/baz';
      // Pad with ASCII to land just under the cap when URL = 23.
      // 280 - 23 - 1 (space) = 256 ASCII chars, then space + URL
      const text = 'a'.repeat(256) + ' ' + url;
      const r = validateReplyLength(text, { platform: 'x', kind: 'reply' });
      // Weighted: 256 ASCII + 1 space + 23 (URL) = 280 → ok
      expect(r.length).toBe(280);
      expect(r.ok).toBe(true);
    });

    it('counts emoji as 2 weighted chars', () => {
      // 278 ASCII + 1 emoji (= 2 weighted) = 280 → boundary pass
      const r = validateReplyLength('a'.repeat(278) + '🚀', {
        platform: 'x',
        kind: 'reply',
      });
      expect(r.length).toBe(280);
      expect(r.ok).toBe(true);

      // One more ASCII pushes over
      const r2 = validateReplyLength('a'.repeat(279) + '🚀', {
        platform: 'x',
        kind: 'reply',
      });
      expect(r2.ok).toBe(false);
      expect(r2.length).toBe(281);
    });

    it('counts CJK characters as 2 weighted chars', () => {
      // 140 CJK chars = 280 weighted → boundary pass
      const r = validateReplyLength('中'.repeat(140), {
        platform: 'x',
        kind: 'reply',
      });
      expect(r.length).toBe(280);
      expect(r.ok).toBe(true);

      const r2 = validateReplyLength('中'.repeat(141), {
        platform: 'x',
        kind: 'reply',
      });
      expect(r2.ok).toBe(false);
      expect(r2.length).toBe(282);
    });

    it('strips leading @mentions on a reply when hasLeadingMentions=true', () => {
      // Leading auto-mentions ("@alice @bob ") + 280 ASCII chars of body
      // are still ok because the mention prefix is excluded from the cap.
      const text = '@alice @bob ' + 'a'.repeat(280);
      const r = validateReplyLength(text, {
        platform: 'x',
        kind: 'reply',
        hasLeadingMentions: true,
      });
      expect(r.ok).toBe(true);
      expect(r.length).toBe(280);
    });

    it('does NOT strip leading mentions when the flag is omitted', () => {
      const text = '@alice @bob ' + 'a'.repeat(280);
      const r = validateReplyLength(text, { platform: 'x', kind: 'reply' });
      // Leading mentions are counted; we'll be over the cap.
      expect(r.ok).toBe(false);
      expect(r.length).toBeGreaterThan(280);
    });
  });

  describe('X — thread support', () => {
    it('treats \\n\\n-separated X posts as a thread and validates each tweet', () => {
      const tweet1 = 'First tweet, well within the cap.';
      const tweet2 = 'Second tweet, also fine.';
      const r = validateReplyLength(`${tweet1}\n\n${tweet2}`, {
        platform: 'x',
        kind: 'post',
      });
      expect(r.isThread).toBe(true);
      expect(r.segmentCount).toBe(2);
      expect(r.ok).toBe(true);
      expect(r.segments).toHaveLength(2);
      expect(r.segments?.[0].ok).toBe(true);
      expect(r.segments?.[1].ok).toBe(true);
    });

    it('fails the thread when ANY single tweet exceeds 280 weighted chars', () => {
      const okTweet = 'Short tweet.';
      const overTweet = 'a'.repeat(281);
      const r = validateReplyLength(`${okTweet}\n\n${overTweet}`, {
        platform: 'x',
        kind: 'post',
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('too_long');
      expect(r.segments?.[0].ok).toBe(true);
      expect(r.segments?.[1].ok).toBe(false);
      expect(r.segments?.[1].excess).toBe(1);
    });

    it('flags too_many_segments when a thread has more than 25 tweets', () => {
      const tweets = Array.from({ length: 26 }, (_, i) => `Tweet ${i + 1}.`);
      const r = validateReplyLength(tweets.join('\n\n'), {
        platform: 'x',
        kind: 'post',
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('too_many_segments');
      expect(r.segmentCount).toBe(26);
    });

    it('does not split single-newline content as a thread', () => {
      const r = validateReplyLength('line one\nline two', {
        platform: 'x',
        kind: 'post',
      });
      expect(r.isThread).toBe(false);
      expect(r.segmentCount).toBe(1);
    });
  });

  describe('Reddit — codepoint counting', () => {
    it('uses reddit post cap of 40,000', () => {
      const r = validateReplyLength('a'.repeat(40_001), {
        platform: 'reddit',
        kind: 'post',
      });
      expect(r.ok).toBe(false);
      expect(r.limit).toBe(40_000);
      expect(r.excess).toBe(1);
    });

    it('uses reddit comment cap of 10,000', () => {
      const r = validateReplyLength('a'.repeat(10_001), {
        platform: 'reddit',
        kind: 'reply',
      });
      expect(r.ok).toBe(false);
      expect(r.limit).toBe(10_000);
    });

    it('counts emoji as one code point on Reddit (not weighted)', () => {
      // Reddit doesn't apply Twitter-style weighting.
      const r = validateReplyLength('a'.repeat(9999) + '🚀', {
        platform: 'reddit',
        kind: 'reply',
      });
      expect(r.ok).toBe(true);
      expect(r.length).toBe(10_000);
    });
  });

  it('throws on an unknown platform (fail loud, not silent)', () => {
    expect(() =>
      validateReplyLength('x', { platform: 'linkedin', kind: 'post' }),
    ).toThrow(/Unknown platform/);
  });
});
