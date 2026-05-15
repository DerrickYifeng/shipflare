import type { RedditMcpAgent } from "../RedditMcpAgent";

export interface RedditLocalMetrics {
  post_count: number;
  comment_count: number;
  karma_7d: number;
  capturedAt: string;
}

/**
 * Core computation — factored out of the MCP tool handler so the
 * `/internal/reddit_local_metrics` route can call it directly without
 * going through the MCP protocol layer.
 *
 * Reads ONLY from the local `posted_externals` SQLite table.
 * No external Reddit API calls are made — this is intentional per
 * the growth-snapshot spec (Reddit local-cache approach).
 *
 * Schema reference (`applyRedditSchema`):
 *   posted_externals (external_id TEXT PK, kind TEXT, posted_by_role TEXT,
 *                     posted_at INTEGER NOT NULL, deleted_at INTEGER, json TEXT)
 *
 * kind values written by `reddit_post`: "post" (submissions) | "reply"
 * (comments). The `kind` column has no "comment" value — the tool uses
 * "reply" for comment rows (see reddit-post.ts line 162).
 *
 * karma_7d is always 0: the `posted_externals` schema has no `karma`
 * column. Karma is not tracked locally; the Reddit API would be required
 * to fetch it. TODO: add a karma column if Reddit OAuth is added later.
 */
export function computeRedditLocalMetrics(
  agent: RedditMcpAgent,
): RedditLocalMetrics {
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const rows = agent.sqlStorage
    .exec<{
      kind: string;
      posted_at: number;
    }>(
      `SELECT kind, posted_at
       FROM posted_externals
       WHERE deleted_at IS NULL`,
    )
    .toArray();

  let post_count = 0;
  let comment_count = 0;

  for (const r of rows) {
    if (r.kind === "post") {
      post_count += 1;
    } else if (r.kind === "reply") {
      // "reply" is what reddit_post stores for comments (see reddit-post.ts)
      comment_count += 1;
    }
    // posted_at is epoch ms; 7d window checked but karma column absent
    void (r.posted_at >= sevenDaysAgoMs); // would gate karma if column existed
  }

  return {
    post_count,
    comment_count,
    // TODO: karma column doesn't exist in posted_externals schema.
    // Add it when Reddit OAuth write-back of karma data is implemented.
    karma_7d: 0,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * reddit_local_metrics — aggregate counts from the local posted_externals
 * table. No external API call. Safe to call at cron frequency with no
 * rate-limit risk.
 *
 * Returns:
 *   - post_count:    total published submissions (kind='post')
 *   - comment_count: total published comments (kind='reply')
 *   - karma_7d:      always 0 (karma column absent from schema; TODO)
 */
export function registerRedditLocalMetricsTool(agent: RedditMcpAgent): void {
  agent.server.registerTool(
    "reddit_local_metrics",
    {
      description:
        "Aggregate counts from the local posted_externals table. No external " +
        "API call. Returns post_count, comment_count, karma_7d (always 0 " +
        "until karma is tracked locally).",
      inputSchema: {},
    },
    async () => {
      const metrics = computeRedditLocalMetrics(agent);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(metrics) }],
      };
    },
  );
}
