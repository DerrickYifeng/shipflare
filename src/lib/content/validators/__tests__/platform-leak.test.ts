import { describe, expect, it } from 'vitest';
import { validatePlatformLeak } from '../platform-leak';

describe('validatePlatformLeak (target=x)', () => {
  it('passes text with no sibling-platform references', () => {
    const r = validatePlatformLeak(
      'shipping a new feature today. here is what changed.',
      { targetPlatform: 'x' },
    );
    expect(r.ok).toBe(true);
    expect(r.leakedPlatforms).toEqual([]);
  });

  it('flags a bare "reddit" mention', () => {
    const r = validatePlatformLeak('saw this on reddit earlier.', {
      targetPlatform: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.leakedPlatforms).toContain('reddit');
  });

  it('flags "r/", "subreddit", "upvote", "karma"', () => {
    for (const phrase of [
      'crossposted from r/SideProject.',
      'found this in a subreddit yesterday.',
      'upvote if you relate.',
      'karma farming is boring.',
    ]) {
      const r = validatePlatformLeak(phrase, { targetPlatform: 'x' });
      expect(r.ok, `failed to flag: ${phrase}`).toBe(false);
      expect(r.leakedPlatforms).toContain('reddit');
    }
  });

  it('allows sibling mentions in a contrast sentence ("unlike")', () => {
    const r = validatePlatformLeak(
      'unlike reddit, X rewards quick concise replies.',
      { targetPlatform: 'x' },
    );
    expect(r.ok).toBe(true);
  });

  it('allows sibling mentions with "vs" contrast', () => {
    const r = validatePlatformLeak('X vs reddit for B2B: X wins on speed.', {
      targetPlatform: 'x',
    });
    expect(r.ok).toBe(true);
  });

  it('allows "instead of" contrast', () => {
    const r = validatePlatformLeak(
      'post on X instead of reddit if you want reach.',
      { targetPlatform: 'x' },
    );
    expect(r.ok).toBe(true);
  });

  it('only allows contrast within the same sentence', () => {
    const r = validatePlatformLeak(
      'we compared tools. we also hang out on reddit sometimes.',
      { targetPlatform: 'x' },
    );
    expect(r.ok).toBe(false);
  });

  it('does not match word fragments ("startup" should not trip "rt")', () => {
    const r = validatePlatformLeak('startup life is wild.', {
      targetPlatform: 'x',
    });
    expect(r.ok).toBe(true);
  });

  it('does not flag English compounds containing "r/" (color/style, year/year)', () => {
    for (const phrase of [
      'pick color/style based on the brand guide.',
      'year/year growth is the metric we track.',
      'our/your code lives in the same monorepo.',
      'founder/operator split is the real conversation.',
    ]) {
      const r = validatePlatformLeak(phrase, { targetPlatform: 'x' });
      expect(r.ok, `falsely flagged: ${phrase}`).toBe(true);
    }
  });

  it('still flags real subreddit references ("r/SideProject")', () => {
    const r = validatePlatformLeak('check r/SideProject this week.', {
      targetPlatform: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.leakedPlatforms).toContain('reddit');
  });

  it('flags multiple claims in one draft', () => {
    const r = validatePlatformLeak(
      'i post on reddit. i farm karma all day.',
      { targetPlatform: 'x' },
    );
    expect(r.ok).toBe(false);
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validatePlatformLeak (target=reddit)', () => {
  it('flags "twitter" / "retweet" when target is reddit', () => {
    const r = validatePlatformLeak('this is a retweet from twitter.', {
      targetPlatform: 'reddit',
    });
    expect(r.ok).toBe(false);
    expect(r.leakedPlatforms).toContain('x');
  });

  it('allows contrast on reddit too', () => {
    const r = validatePlatformLeak(
      'unlike twitter, reddit gives you room to explain.',
      { targetPlatform: 'reddit' },
    );
    expect(r.ok).toBe(true);
  });

  it('does not flag word-ending-in-rt followed by @handle (smart @joe, start @noon)', () => {
    for (const phrase of [
      'smart @joe was on the call.',
      'start @noon if that works for you.',
      'art @sothebys auction was wild.',
      'part @section_2 of the doc.',
    ]) {
      const r = validatePlatformLeak(phrase, { targetPlatform: 'reddit' });
      expect(r.ok, `falsely flagged: ${phrase}`).toBe(true);
    }
  });

  it('still flags real retweet token ("RT @handle")', () => {
    const r = validatePlatformLeak('RT @somefounder this is great.', {
      targetPlatform: 'reddit',
    });
    expect(r.ok).toBe(false);
    expect(r.leakedPlatforms).toContain('x');
  });
});

describe('validatePlatformLeak error handling', () => {
  it('throws on unknown target platform', () => {
    expect(() =>
      validatePlatformLeak('hi', { targetPlatform: 'linkedin' }),
    ).toThrow(/Unknown platform/);
  });
});
