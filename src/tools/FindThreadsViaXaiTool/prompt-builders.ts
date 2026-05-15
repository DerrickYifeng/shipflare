// First-turn xAI user-message builders, one per platform.
//
// X and Reddit each get their own builder so platform-specific
// vocabulary (likes vs score, @handle vs u/handle, quote-tweets vs
// crossposts, the seed subreddit list, the "use web search restricted
// to reddit.com" instruction) lives in exactly one place.
//
// Both builders share the same signature shape, including the
// `excludeSelfHandle` parameter — when non-null we add a Do-NOT line
// so xAI doesn't surface the founder's own posts as reply candidates.

import type { ProductForLoop } from './FindThreadsViaXaiTool';

const PROMPT_AUTHOR_LIMIT = 50;

/** Build the first-turn xAI user message for X/Twitter discovery. */
export function buildXFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
  excludeAuthors: readonly string[],
  excludeSelfHandle: string | null,
): string {
  const keywords =
    product.keywords.length > 0 ? product.keywords.join(', ') : '(none)';
  const intentLine = intent ? `\nFOUNDER INTENT\n${intent}\n` : '';
  const rubricSection = rubric
    ? `\nICP RUBRIC (from onboarding)\n${rubric}\n`
    : '';

  const trimmed = excludeAuthors.slice(0, PROMPT_AUTHOR_LIMIT);
  const tail =
    excludeAuthors.length > PROMPT_AUTHOR_LIMIT
      ? ' and others — when in doubt, skip authors that look like our prior reply targets'
      : '';
  const excludeLine =
    trimmed.length > 0
      ? `- Do NOT surface tweets authored by: ${trimmed
          .map((h) => '@' + h)
          .join(', ')}${tail}. We have already engaged with them recently and another reply would feel like reply-guy harassment.`
      : '';

  const selfLine = excludeSelfHandle
    ? `- Do NOT surface tweets authored by @${excludeSelfHandle} — that is the founder running this product. Their own posts are not reply targets.`
    : '';

  return [
    "I'm looking for X/Twitter posts where potential customers of my product",
    'are publicly expressing problems the product solves.',
    '',
    'PRODUCT',
    `- Name: ${product.name}`,
    `- Description: ${product.description}`,
    `- Value prop: ${product.valueProp ?? '(not specified)'}`,
    `- Target audience: ${product.targetAudience ?? '(not specified)'}`,
    `- Keywords: ${keywords}`,
    intentLine + rubricSection,
    'Constraints',
    '- Posted in last 7 days',
    `- Up to ${maxResults * 2} candidates this pass — quality over quota`,
    ...(selfLine ? [selfLine] : []),
    ...(excludeLine ? [excludeLine] : []),
    '- For each tweet include: url, author_username, author_bio, author_followers,',
    '  body, posted_at, likes_count, reposts_count, replies_count, views_count,',
    '  is_repost, original_url, original_author_username, surfaced_via,',
    '  confidence (your 0-1 assessment), reason (1 sentence, product-specific)',
    '- Reposts ARE valuable signal — when a relevant person reposts a thread on',
    "  the product's pain, that thread is a strong reply target. Include reposts;",
    '  do NOT filter them out as noise. The reply target for a repost is the',
    '  ORIGINAL author (set original_url + original_author_username; surfaced_via',
    '  carries the reposter handle).',
    '- If the tweet QUOTES another tweet, include `quoted_text` (the quoted post',
    "  body, verbatim) and `quoted_author` (the quoted author's @handle, no @).",
    '  If the tweet is a REPLY in a thread, include `in_reply_to_text` (the parent',
    "  post body, verbatim) and `in_reply_to_author` (parent author's @handle).",
    '  Leave any of these null when not applicable. A standalone tweet has all four',
    '  null. A self-quote (quoted_author == author_username) is allowed and common —',
    '  surface it.',
    "- Empty `tweets` is allowed if you genuinely find nothing — don't pad.",
  ].join('\n');
}

/** Build the first-turn xAI user message for Reddit discovery. */
export function buildRedditFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
  excludeAuthors: readonly string[],
  excludeSelfHandle: string | null,
): string {
  const keywords =
    product.keywords.length > 0 ? product.keywords.join(', ') : '(none)';
  const intentLine = intent ? `\nFOUNDER INTENT\n${intent}\n` : '';
  const rubricSection = rubric
    ? `\nICP RUBRIC (from onboarding)\n${rubric}\n`
    : '';

  const trimmed = excludeAuthors.slice(0, PROMPT_AUTHOR_LIMIT);
  const tail =
    excludeAuthors.length > PROMPT_AUTHOR_LIMIT
      ? ' and others — when in doubt, skip authors that look like our prior reply targets'
      : '';
  const excludeLine =
    trimmed.length > 0
      ? `- Do NOT surface threads authored by: ${trimmed
          .map((h) => 'u/' + h)
          .join(', ')}${tail}. We have already replied to them recently.`
      : '';

  const selfLine = excludeSelfHandle
    ? `- Do NOT surface threads authored by u/${excludeSelfHandle} — that is the founder running this product.`
    : '';

  return [
    "I'm looking for recent Reddit threads where potential customers of my product",
    'are publicly expressing problems the product solves. Use web search,',
    'restricted to reddit.com.',
    '',
    'PRODUCT',
    `- Name: ${product.name}`,
    `- Description: ${product.description}`,
    `- Value prop: ${product.valueProp ?? '(not specified)'}`,
    `- Target audience: ${product.targetAudience ?? '(not specified)'}`,
    `- Keywords: ${keywords}`,
    intentLine + rubricSection,
    'Constraints',
    '- Reddit threads only — return reddit.com URLs (any subreddit)',
    '- Posted in the last 7 days',
    `- Up to ${maxResults * 2} candidates this pass — quality over quota`,
    ...(selfLine ? [selfLine] : []),
    ...(excludeLine ? [excludeLine] : []),
    '- Skip launch / self-promo posts where OP is pitching THEIR OWN tool',
    '  (r/SaaS / r/SideProject launch threads are not reply targets — they are not in pain)',
    '- Likely subreddits to scan (not exhaustive — explore others):',
    '  r/SaaS, r/indiehackers, r/Entrepreneur, r/startups, r/EntrepreneurRideAlong,',
    '  r/SideProject, r/microsaas, r/SmallBusiness, r/marketing, r/growmybusiness',
    '- For each thread include: external_id (reddit base36 thread ID, the part after /comments/),',
    '  url, subreddit (without r/), author_username (without u/), author_karma (integer | null),',
    '  title, body (first 500 chars selftext, single line), posted_at (ISO 8601 UTC),',
    '  score, num_comments, num_crossposts, is_self, link_url (string | null), over_18,',
    '  locked, archived, confidence (0-1), reason (ONE sentence; quote 3-8 words from the post)',
    "- Empty `threads` is allowed if you genuinely find nothing — don't pad.",
  ].join('\n');
}
