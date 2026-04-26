// X-thread split helpers shared between the server-side validator and the
// client-side post card. Pure string ops — safe to import in a browser
// bundle (no twitter-text, no node deps). The actual weighted-length
// check lives in `src/lib/content/validators/length.ts`; this module is
// just the segment boundary.

/**
 * Tweets in a draft thread are joined by a blank-line separator. We treat
 * any run of two or more newlines as the segment boundary so we don't
 * false-split a single tweet that happens to contain a soft newline. The
 * validator uses the same regex (`length.ts`) — keep them in sync.
 */
export const X_THREAD_SEGMENT_SEPARATOR = /\n{2,}/;

/**
 * Split an X post body into its constituent tweets. Returns the original
 * (trimmed) body wrapped in a single-element array when there is no
 * blank-line separator — callers can branch on `result.length > 1` to
 * decide whether to render a thread UI.
 *
 * Empty / whitespace-only segments are dropped so a trailing `\n\n` at
 * the end of a body doesn't surface as a phantom empty tweet.
 */
export function splitXTweets(body: string): string[] {
  if (typeof body !== 'string' || body.trim().length === 0) return [];
  return body
    .split(X_THREAD_SEGMENT_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
