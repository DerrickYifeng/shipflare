import { z } from "zod";
import { getChannel } from "../../../../lib/channel";
import type { XMcpAgent } from "../XMcpAgent";
import { requireChannel, requireUserId } from "../../_shared/guards";

/**
 * x_metrics — fetch engagement metrics for a previously-published tweet.
 *
 * Not role-gated: reads are fine for members (e.g. SMM running a
 * post-publication audit). The OAuth token is still required because
 * X's `tweet.fields=public_metrics` endpoint is gated to authenticated
 * callers (technically the metrics are public for bearer-auth, but the
 * token validates the user's quota bucket).
 *
 * Side-effect: when the tweet id matches a `posted_externals` row, the
 * `json` column is updated with the latest metrics envelope. This makes
 * `/today` and post-publication audits cheap — they can read the row
 * once per refresh interval instead of round-tripping to X every load.
 * Returning the response unchanged keeps the MCP contract shape stable
 * for callers that don't care about the side-effect.
 */
export function registerXMetricsTool(agent: XMcpAgent): void {
  agent.server.registerTool(
    "x_metrics",
    {
      description:
        "Fetch engagement metrics (impressions, likes, reposts, replies, " +
        "bookmarks) for a previously-published tweet by external id. " +
        "Also updates posted_externals.json with the latest envelope.",
      inputSchema: {
        externalId: z.string().min(1),
      },
    },
    async ({ externalId }) => {
      const props = agent.props;
      const userId = requireUserId(props, "XMcpAgent");
      const channel = requireChannel(
        await getChannel(agent.bindings, userId, "x"),
        "X",
      );

      const url =
        `https://api.twitter.com/2/tweets/${encodeURIComponent(externalId)}` +
        `?tweet.fields=public_metrics`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
        },
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(
          `X metrics fetch failed (${res.status}): ${errText.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as unknown;

      // Best-effort update of the local mirror. We don't gate this on a
      // SELECT — UPDATE on a non-existent row is a no-op, which is the
      // right semantics: external clients metricsing a third party's
      // tweet shouldn't pollute our posted_externals.
      agent.sqlStorage.exec(
        `UPDATE posted_externals SET json = ? WHERE external_id = ?`,
        JSON.stringify(json),
        externalId,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(json) }],
      };
    },
  );
}
