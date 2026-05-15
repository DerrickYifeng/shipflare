import { getChannel } from "../../../../lib/channel";
import type { XMcpAgent } from "../XMcpAgent";
import { requireUserId } from "../../_shared/guards";

export interface XAggregateMetrics {
  impressions: number;
  likes: number;
  replies: number;
  reposts: number;
  followers: number;
  posts_7d: number;
  capturedAt: string;
}

const ZERO_METRICS: XAggregateMetrics = {
  impressions: 0,
  likes: 0,
  replies: 0,
  reposts: 0,
  followers: 0,
  posts_7d: 0,
  capturedAt: new Date().toISOString(),
};

/**
 * Core computation — factored out of the MCP tool handler so the
 * `/internal/x_aggregate_metrics` route can call it directly without
 * going through the MCP protocol layer.
 *
 * Makes two X API calls per invocation:
 *   1. GET /2/users/me  — follower count + numeric user id
 *   2. GET /2/users/:id/tweets — last `lookbackTweets` tweets' public_metrics
 *
 * Returns zero-valued metrics when the user has no active X channel;
 * throws on X API errors so the caller can isolate failures per-user.
 */
export async function computeXAggregateMetrics(
  agent: XMcpAgent,
  lookbackTweets = 30,
): Promise<XAggregateMetrics> {
  const userId = requireUserId(agent.props, "XMcpAgent");
  const channel = await getChannel(agent.bindings, userId, "x");

  if (!channel) {
    // No connected X channel — return zeros, no API call.
    return { ...ZERO_METRICS, capturedAt: new Date().toISOString() };
  }

  const { accessToken } = channel;
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Step A: GET user object (follower count + numeric user id).
  const userRes = await fetch(
    "https://api.twitter.com/2/users/me?user.fields=public_metrics",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!userRes.ok) {
    const text = await userRes.text().catch(() => "(no body)");
    throw new Error(
      `X users/me fetch failed (${userRes.status}): ${text.slice(0, 300)}`,
    );
  }
  const userData = (await userRes.json()) as {
    data: { id: string; public_metrics?: { followers_count?: number } };
  };
  const numericId = userData.data.id;
  const followers = userData.data.public_metrics?.followers_count ?? 0;

  // Step B: GET user's recent tweets with public_metrics.
  const tweetsUrl =
    `https://api.twitter.com/2/users/${numericId}/tweets` +
    `?max_results=${lookbackTweets}` +
    `&tweet.fields=public_metrics,created_at` +
    `&exclude=retweets,replies`;
  const tweetsRes = await fetch(tweetsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!tweetsRes.ok) {
    const text = await tweetsRes.text().catch(() => "(no body)");
    throw new Error(
      `X users/:id/tweets fetch failed (${tweetsRes.status}): ${text.slice(0, 300)}`,
    );
  }
  const tweetsData = (await tweetsRes.json()) as {
    data?: Array<{
      id: string;
      created_at?: string;
      public_metrics?: {
        impression_count?: number;
        like_count?: number;
        reply_count?: number;
        retweet_count?: number;
        quote_count?: number;
      };
    }>;
  };

  let impressions = 0;
  let likes = 0;
  let replies = 0;
  let reposts = 0;
  let posts_7d = 0;

  for (const t of tweetsData.data ?? []) {
    const m = t.public_metrics ?? {};
    impressions += m.impression_count ?? 0;
    likes += m.like_count ?? 0;
    replies += m.reply_count ?? 0;
    reposts += (m.retweet_count ?? 0) + (m.quote_count ?? 0);
    if (t.created_at && t.created_at >= sevenDaysAgo) {
      posts_7d += 1;
    }
  }

  return {
    impressions,
    likes,
    replies,
    reposts,
    followers,
    posts_7d,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * x_aggregate_metrics — aggregate engagement metrics across the user's
 * last N tweets plus their user object.
 *
 * Returns sums for impressions / likes / replies / reposts, plus
 * followers count and the number of original posts in the last 7 days.
 *
 * Designed for the growth-snapshot cron (every 6h); each user gets one
 * call to /users/me and one to /users/:id/tweets per run. Rate-limit
 * impact is low with a small user base.
 */
export function registerXAggregateMetricsTool(agent: XMcpAgent): void {
  agent.server.registerTool(
    "x_aggregate_metrics",
    {
      description:
        "Aggregate engagement metrics across the user's last 30 tweets plus " +
        "their user object. Returns sums for impressions/likes/replies/reposts " +
        "plus followers and post_count_7d.",
      inputSchema: {},
    },
    async () => {
      const metrics = await computeXAggregateMetrics(agent, 30);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(metrics) }],
      };
    },
  );
}
