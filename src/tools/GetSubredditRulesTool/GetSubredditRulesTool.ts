import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';
import { RedditClient } from '@/lib/reddit-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('tools:get-subreddit-rules');

export const GET_SUBREDDIT_RULES_TOOL_NAME = 'get_subreddit_rules';

/**
 * Fetch a subreddit's posted rules so drafting skills can avoid violating
 * sub-specific norms (no self-promo, no AI tools, etc.).
 *
 * Reddit's `/r/{subreddit}/about/rules` endpoint is publicly readable, so
 * this tool uses `RedditClient.appOnly()` and does NOT require an OAuth-
 * connected channel. That makes it safe to call from public endpoints
 * (e.g. /api/scan) and from drafting forks that haven't been wired with a
 * per-user `redditClient` dep.
 *
 * Failure mode is intentionally graceful: returns `[]` on network errors,
 * unknown subreddits, or rate-limit. Drafting MUST NOT fail because we
 * couldn't fetch rules — the skill prompt treats absent rules the same as
 * "no relevant rules to apply."
 */
export const getSubredditRulesTool = buildTool({
  name: GET_SUBREDDIT_RULES_TOOL_NAME,
  description:
    'Fetch the rules of a specific subreddit so the draft does not violate them. ' +
    'Returns an array of { short_name, description } objects. Returns [] if the ' +
    'subreddit has no rules or the call fails (degrades gracefully).',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: z.object({
    subreddit: z
      .string()
      .min(1)
      .max(100)
      .describe('Subreddit name without r/ prefix'),
  }),
  async execute(input): Promise<Array<{ short_name: string; description: string }>> {
    try {
      const client = RedditClient.appOnly();
      const rules = await client.getSubredditRules(input.subreddit);
      // RedditClient.getSubredditRules returns { title, description, kind } —
      // map to the public { short_name, description } contract.
      return rules.map((r) => ({
        short_name: r.title,
        description: r.description,
      }));
    } catch (err) {
      log.warn(
        `get_subreddit_rules failed for r/${input.subreddit} — returning [] so drafting can proceed`,
        err,
      );
      return [];
    }
  },
});
