import { describe, expect, it } from 'vitest';
import { buildXIntentUrl } from '../x-intent-url';

describe('buildXIntentUrl', () => {
  it('builds a top-level post intent URL', () => {
    const url = buildXIntentUrl({ text: 'hello world' });
    expect(url).toBe('https://x.com/intent/post?text=hello+world');
  });

  it('encodes special characters', () => {
    const url = buildXIntentUrl({ text: 'a&b=c?d' });
    expect(url).toContain('a%26b%3Dc%3Fd');
  });

  it('includes in_reply_to_tweet_id when replying', () => {
    const url = buildXIntentUrl({
      text: 'reply',
      inReplyToTweetId: '1234567890',
    });
    expect(url).toContain('text=reply');
    expect(url).toContain('in_reply_to_tweet_id=1234567890');
  });

  it('rejects empty text', () => {
    expect(() => buildXIntentUrl({ text: '' })).toThrow(/text/i);
  });
});
