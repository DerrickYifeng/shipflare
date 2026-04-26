/**
 * Minimal type declarations for `twitter-text` v3.x. The published package
 * ships no types; we only use `parseTweet`, so we declare just what we
 * consume. See https://github.com/twitter/twitter-text for full surface.
 */
declare module 'twitter-text' {
  export interface ParseTweetResult {
    /** X's weighted length: t.co URLs = 23, emoji = 2, CJK = 2, ASCII = 1. */
    weightedLength: number;
    /** True iff weightedLength > 0 and <= maxWeightedTweetLength. */
    valid: boolean;
    /** Weighted length / max, in per-mille (0..1000+). */
    permillage: number;
    validRangeStart: number;
    validRangeEnd: number;
    displayRangeStart: number;
    displayRangeEnd: number;
  }

  export interface ParseTweetOptions {
    version?: number;
    maxWeightedTweetLength?: number;
    scale?: number;
    defaultWeight?: number;
    transformedURLLength?: number;
    ranges?: Array<{ start: number; end: number; weight: number }>;
    emojiParsingEnabled?: boolean;
  }

  export function parseTweet(
    text: string,
    options?: ParseTweetOptions,
  ): ParseTweetResult;

  const _default: {
    parseTweet: typeof parseTweet;
  };
  export default _default;
}
