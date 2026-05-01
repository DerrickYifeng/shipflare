// query_recent_x_posts — return the founder's last N days of X tweets.
//
// Wraps XClient.getMe + getUserTweets and shapes the result for the
// content-planner. The planner reads bodies + engagement metrics and
// derives metaphor_ban for each plan_item it's about to add.
//
// Auth: looks up the user's X channel via standard channels query,
// instantiates XClient via XClient.fromChannel (the sanctioned helper
// for already-loaded channel rows). When the user has no X channel or
// the token refresh fails, the tool returns { tweets: [], error } so
// the planner can proceed without metaphor_ban.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { channels } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { XClient, XRateLimitError } from '@/lib/x-client';
import { createClientFromChannelById } from '@/lib/platform-deps';

export const QUERY_RECENT_X_POSTS_TOOL_NAME = 'query_recent_x_posts';

// Default for `days` is applied inside `execute` rather than via
// `.transform()` so the schema's input/output stay structurally identical
// — `buildTool` accepts `z.ZodType<TInput>` (one generic), and a transform
// schema's input/output diverge, which previously forced an `as any` cast.
export const queryRecentXPostsInputSchema = z
  .object({
    days: z.number().int().min(1).max(60).optional(),
  })
  .strict();

const DEFAULT_WINDOW_DAYS = 14;

export type QueryRecentXPostsInput = z.infer<
  typeof queryRecentXPostsInputSchema
>;

export interface QueryRecentXPostsTweet {
  tweetId: string;
  date: string;
  kind: 'original' | 'reply';
  body: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    impressions: number;
  };
}

export type QueryRecentXPostsError =
  | 'no_channel'
  | 'token_invalid'
  | 'rate_limited'
  | 'api_error';

export interface QueryRecentXPostsResult {
  source: 'x_api';
  windowDays: number;
  tweets: QueryRecentXPostsTweet[];
  error?: QueryRecentXPostsError;
}

function classifyError(err: unknown): QueryRecentXPostsError {
  if (err instanceof XRateLimitError) return 'rate_limited';
  const message =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes('unauthorized') || message.includes('token')) {
    return 'token_invalid';
  }
  if (message.includes('rate') || message.includes('429')) {
    return 'rate_limited';
  }
  return 'api_error';
}

export const queryRecentXPostsTool: ToolDefinition<
  QueryRecentXPostsInput,
  QueryRecentXPostsResult
> = buildTool({
  name: QUERY_RECENT_X_POSTS_TOOL_NAME,
  description:
    "Return the founder's last N days (default 14) of X tweets — both " +
    'original posts and replies — with engagement metrics. The ' +
    'content-planner uses this to derive metaphor_ban and pick a ' +
    'pillar mix for the upcoming week. Returns { tweets: [], error } ' +
    'when the user has no X channel or the token is invalid; the ' +
    'planner should proceed without metaphor_ban in that case.',
  inputSchema: queryRecentXPostsInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input: QueryRecentXPostsInput, ctx): Promise<QueryRecentXPostsResult> {
    const { db, userId } = readDomainDeps(ctx);
    const windowDays = input.days ?? DEFAULT_WINDOW_DAYS;

    // 1. Find the user's X channel.
    // Projection limited to `id` so we never pull encrypted token columns
    // into a plain object. Token decryption + client instantiation happens
    // inside the sanctioned helper `createClientFromChannelById`.
    const [channelMeta] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.userId, userId), eq(channels.platform, 'x')))
      .limit(1);

    if (!channelMeta) {
      return {
        source: 'x_api',
        windowDays,
        tweets: [],
        error: 'no_channel',
      };
    }

    // 2. Instantiate XClient via the sanctioned helper.
    let xClient: XClient;
    try {
      const resolved = await createClientFromChannelById(channelMeta.id);
      if (!resolved) {
        return {
          source: 'x_api',
          windowDays,
          tweets: [],
          error: 'no_channel',
        };
      }
      xClient = resolved.client as XClient;
    } catch (err) {
      return {
        source: 'x_api',
        windowDays,
        tweets: [],
        error: classifyError(err),
      };
    }

    // 3. Resolve the user's numeric X id, then fetch recent tweets.
    let me: Awaited<ReturnType<typeof XClient.prototype.getMe>>;
    let result: Awaited<ReturnType<typeof XClient.prototype.getUserTweets>>;
    try {
      me = await xClient.getMe();
      result = await xClient.getUserTweets(me.id, { maxResults: 30 });
    } catch (err) {
      return {
        source: 'x_api',
        windowDays,
        tweets: [],
        error: classifyError(err),
      };
    }

    // 4. Filter to the window and shape for the planner.
    const cutoff = Date.now() - windowDays * 86_400_000;
    const tweets: QueryRecentXPostsTweet[] = result.tweets
      .filter((t) => {
        if (!t.createdAt) return false;
        return new Date(t.createdAt).getTime() >= cutoff;
      })
      .map((t) => ({
        tweetId: t.id,
        date: t.createdAt as string, // Filter ensures createdAt exists
        kind: t.referencedTweets?.some((r) => r.type === 'replied_to')
          ? ('reply' as const)
          : ('original' as const),
        body: t.text,
        metrics: {
          likes: t.metrics?.likes ?? 0,
          retweets: t.metrics?.retweets ?? 0,
          replies: t.metrics?.replies ?? 0,
          impressions: t.metrics?.impressions ?? 0,
        },
      }));

    return { source: 'x_api', windowDays, tweets };
  },
});
