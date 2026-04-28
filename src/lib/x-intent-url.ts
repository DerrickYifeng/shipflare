/**
 * Build a TOS-compliant X intent URL. Opening this URL in the user's
 * browser pre-fills X's compose box with the draft text. The user clicks
 * "Post" themselves — we never call the X API for this draft, so the
 * Feb 2026 programmatic-reply restriction does not apply.
 *
 * Docs: https://developer.x.com/en/docs/x-for-websites/web-intents/overview
 */
export interface XIntentInput {
  text: string;
  /** Tweet id to reply to. Omit for top-level tweets. */
  inReplyToTweetId?: string;
}

export function buildXIntentUrl({
  text,
  inReplyToTweetId,
}: XIntentInput): string {
  if (!text || !text.trim()) {
    throw new Error('buildXIntentUrl: text is required');
  }
  const params = new URLSearchParams({ text });
  if (inReplyToTweetId) {
    // Web Intent uses `in_reply_to` (NOT `in_reply_to_tweet_id` — that's the
    // POST /2/tweets API field name; the URL parameter is different).
    params.set('in_reply_to', inReplyToTweetId);
  }
  return `https://x.com/intent/post?${params.toString()}`;
}
