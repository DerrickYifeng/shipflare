import { describe, it, expect } from 'vitest';
import { buildRedditSubmitUrl } from '../reddit-intent-url';

describe('buildRedditSubmitUrl', () => {
  it('returns a self-text submit URL with type, title, selftext params', () => {
    const url = buildRedditSubmitUrl({
      subreddit: 'SaaS',
      title: 'How I got my first 100 users',
      body: 'Step 1 was reddit.',
    });
    expect(url).toMatch(/^https:\/\/www\.reddit\.com\/r\/SaaS\/submit\?/);
    expect(url).toContain('type=text');
    expect(url).toContain('title=How+I+got+my+first+100+users');
    expect(url).toContain('selftext=Step+1+was+reddit.');
  });

  it('throws on empty title', () => {
    expect(() =>
      buildRedditSubmitUrl({ subreddit: 'SaaS', title: '', body: 'x' }),
    ).toThrow(/title is required/);
  });

  it('throws on empty subreddit', () => {
    expect(() =>
      buildRedditSubmitUrl({ subreddit: '', title: 'x', body: 'y' }),
    ).toThrow(/subreddit is required/);
  });

  it('throws when body exceeds Reddit selftext cap (40_000 chars)', () => {
    const huge = 'x'.repeat(40_001);
    expect(() =>
      buildRedditSubmitUrl({ subreddit: 'SaaS', title: 't', body: huge }),
    ).toThrow(/body too long/);
  });

  it('URL-encodes ampersands and emoji in title', () => {
    const url = buildRedditSubmitUrl({
      subreddit: 'SaaS',
      title: 'Tools & tactics 🚀',
      body: 'x',
    });
    // URLSearchParams encodes '&' as '%26' and emoji as URL-safe form.
    expect(url).toContain('title=Tools+%26+tactics+%F0%9F%9A%80');
  });

  it('strips leading r/ from subreddit if accidentally included', () => {
    const url = buildRedditSubmitUrl({
      subreddit: 'r/SaaS',
      title: 't',
      body: 'b',
    });
    expect(url).toContain('/r/SaaS/submit');
    expect(url).not.toContain('/r/r/SaaS');
  });
});
