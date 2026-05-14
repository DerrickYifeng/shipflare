import { z } from "zod";
import { getChannel } from "../../../../lib/channel";
import type { XMcpAgent } from "../XMcpAgent";
import {
  requireChannel,
  requirePublishPermission,
  requireUserId,
} from "./lib/guards";

/**
 * x_post — publish a tweet or reply on behalf of the OAuth-bound user.
 *
 * Role-gated: only `role='lead'` or `caller='external'` may invoke this.
 * Members (SMM workers, peer agents) can only DRAFT — they cannot
 * publish. See `lib/guards.ts:requirePublishPermission` for the rule.
 *
 * OAuth: token loaded via `getChannel(env, userId, "x")`. This is the
 * SINGLE sanctioned reader of `channels.oauth_token_encrypted` in
 * apps/core (CLAUDE.md Security TODO §1). Tools MUST NOT reach past
 * `getChannel` to touch encrypted columns directly.
 *
 * Idempotency: after a successful publish, we insert into
 * `posted_externals` keyed on the tweet id returned by X. INSERT OR
 * REPLACE makes retries safe — if the same caller re-runs after a
 * partial failure, the row is overwritten rather than duplicated.
 *
 * Failure shape: any non-2xx from X raises with the status + a snippet
 * of the body. Callers should treat this as a hard error — there's no
 * partial-success state to recover from for a single tweet POST.
 */
export function registerXPostTool(agent: XMcpAgent): void {
  agent.server.registerTool(
    "x_post",
    {
      description:
        "Publish a tweet or reply on X. Role-gated: requires role='lead' " +
        "or caller='external'. Members draft; founders/external publish.",
      inputSchema: {
        body: z.string().min(1).max(280),
        replyToExternalId: z
          .string()
          .optional()
          .describe(
            "If set, post as a reply to this tweet id. Otherwise standalone.",
          ),
      },
    },
    async ({ body, replyToExternalId }) => {
      const props = agent.props;
      requirePublishPermission(props);
      const userId = requireUserId(props);

      const channel = requireChannel(
        await getChannel(agent.bindings, userId, "x"),
      );

      const apiBody: {
        text: string;
        reply?: { in_reply_to_tweet_id: string };
      } = { text: body };
      if (replyToExternalId) {
        apiBody.reply = { in_reply_to_tweet_id: replyToExternalId };
      }

      const res = await fetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(apiBody),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(
          `X post failed (${res.status}): ${errText.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as {
        data: { id: string; text: string };
      };
      const tweetId = json.data.id;
      const url = `https://x.com/${channel.username ?? "i"}/status/${tweetId}`;

      // Persist to posted_externals. INSERT OR REPLACE handles retry
      // semantics — same tweetId surfaces here only on a redrive of a
      // partial failure, never as a duplicate.
      agent.sqlStorage.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        tweetId,
        replyToExternalId ? "reply" : "post",
        props?.role ?? props?.caller ?? "unknown",
        Date.now(),
        JSON.stringify(json.data),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: tweetId, url }),
          },
        ],
      };
    },
  );
}
