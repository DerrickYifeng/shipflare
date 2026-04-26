import { describe, it, expect } from 'vitest';
import { splitXTweets, X_THREAD_SEGMENT_SEPARATOR } from '../x-thread';

describe('splitXTweets', () => {
  it('returns a single-segment array for a non-thread body', () => {
    const result = splitXTweets('one tweet, no blank lines');
    expect(result).toEqual(['one tweet, no blank lines']);
  });

  it('splits a 2-tweet thread on a blank-line boundary', () => {
    const body = 'first tweet\n\nsecond tweet';
    expect(splitXTweets(body)).toEqual(['first tweet', 'second tweet']);
  });

  it('splits a 5-tweet thread (matches the validator path)', () => {
    const body = ['t1', 't2', 't3', 't4', 't5'].join('\n\n');
    expect(splitXTweets(body)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('treats 3+ newlines as a single boundary (not phantom empty segments)', () => {
    const body = 'first tweet\n\n\n\nsecond tweet';
    expect(splitXTweets(body)).toEqual(['first tweet', 'second tweet']);
  });

  it('does NOT split on a single soft newline inside a tweet', () => {
    const body = 'line one\nline two of the same tweet';
    expect(splitXTweets(body)).toEqual([
      'line one\nline two of the same tweet',
    ]);
  });

  it('drops trailing/leading whitespace and empty segments', () => {
    const body = '\n\nfirst\n\n\n\nsecond\n\n';
    expect(splitXTweets(body)).toEqual(['first', 'second']);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(splitXTweets('')).toEqual([]);
    expect(splitXTweets('   \n\n   ')).toEqual([]);
  });

  it('exposes the same separator regex the validator uses', () => {
    // Sanity check: any change to this regex must be made in lockstep
    // with src/lib/content/validators/length.ts.
    expect('a\n\nb'.split(X_THREAD_SEGMENT_SEPARATOR)).toEqual(['a', 'b']);
    expect('a\nb'.split(X_THREAD_SEGMENT_SEPARATOR)).toEqual(['a\nb']);
  });
});
