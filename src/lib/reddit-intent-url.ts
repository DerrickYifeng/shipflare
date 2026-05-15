/**
 * Build a TOS-compliant Reddit submit URL for a self (text) post.
 * Opening this URL in the user's browser pre-fills Reddit's submit form.
 * The user clicks "Post" themselves — we never call Reddit's write API,
 * so we do not need an OAuth app for this path.
 *
 * Docs: https://www.reddit.com/wiki/submitting (informal)
 */
export interface RedditSubmitInput {
  /** Subreddit name without the r/ prefix (function strips r/ if included). */
  subreddit: string;
  title: string;
  /** Selftext body. Reddit's hard cap is 40_000 chars. */
  body: string;
}

const REDDIT_SELFTEXT_CAP = 40_000;

export function buildRedditSubmitUrl({
  subreddit,
  title,
  body,
}: RedditSubmitInput): string {
  const sub = subreddit.trim().replace(/^r\//, '');
  if (!sub) {
    throw new Error('buildRedditSubmitUrl: subreddit is required');
  }
  if (!title || !title.trim()) {
    throw new Error('buildRedditSubmitUrl: title is required');
  }
  if (body.length > REDDIT_SELFTEXT_CAP) {
    throw new Error(
      `buildRedditSubmitUrl: body too long (${body.length} > ${REDDIT_SELFTEXT_CAP})`,
    );
  }
  const params = new URLSearchParams({
    type: 'text',
    title,
    selftext: body,
  });
  return `https://www.reddit.com/r/${sub}/submit?${params.toString()}`;
}
