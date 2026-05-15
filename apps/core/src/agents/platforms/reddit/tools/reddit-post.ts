import { z } from "zod";
import { getChannel } from "../../../../lib/channel";
import type { RedditMcpAgent } from "../RedditMcpAgent";
import {
  requireChannel,
  requirePublishPermission,
  requireUserId,
} from "../../_shared/guards";

/**
 * reddit_post — publish a submission (text post) or comment (reply)
 * on behalf of the OAuth-bound user.
 *
 * Role-gated: only `role='lead'` or `caller='external'` may invoke
 * this. Members (SMM workers, peer agents) can only DRAFT — they
 * cannot publish. See `_shared/guards.ts:requirePublishPermission`.
 *
 * OAuth: token loaded via `getChannel(env, userId, "reddit")`. This
 * is the SINGLE sanctioned reader of `channels.oauth_token_encrypted`
 * (CLAUDE.md Security TODO §1). Tools MUST NOT reach past
 * `getChannel` to touch encrypted columns directly.
 *
 * Endpoint shape:
 *   - Submission: POST https://oauth.reddit.com/api/submit
 *                  with sr / title / kind=self / text
 *   - Comment:    POST https://oauth.reddit.com/api/comment
 *                  with thing_id (fullname like t3_<id>) / text
 *
 * `replyToExternalId` MAY arrive with or without a Reddit "thing"
 * prefix (`t1_`, `t3_`). When the prefix is missing we assume it's a
 * submission id and prepend `t3_` (the only kind `reddit_search`
 * surfaces today). Future tools that surface comments will pass the
 * fullname verbatim.
 *
 * Idempotency: after a successful publish, we insert into
 * `posted_externals` keyed on the fullname returned by Reddit
 * (`data.name`, e.g. `t3_abc123`). INSERT OR REPLACE makes retries
 * safe — same callerId surfaces here only on a redrive of a partial
 * failure, never as a duplicate.
 *
 * Failure shape: any non-2xx raises with the status + a snippet of
 * the body. `result.json.errors` is Reddit's app-layer error array
 * (rate-limited, banned-domain, deleted-parent, etc.) — we surface
 * the array contents in the error message so callers can route by
 * cause without re-parsing.
 */
export function registerRedditPostTool(agent: RedditMcpAgent): void {
  agent.server.registerTool(
    "reddit_post",
    {
      description:
        "Publish a Reddit submission or comment. Role-gated: requires " +
        "role='lead' or caller='external'. Members draft; founders/" +
        "external publish.",
      inputSchema: {
        subreddit: z.string().min(1),
        title: z.string().optional(),
        body: z.string().min(1),
        replyToExternalId: z
          .string()
          .optional()
          .describe(
            "If set, comment on this submission/comment (fullname or bare id). " +
              "Otherwise post a new submission to `subreddit`.",
          ),
      },
    },
    async ({ subreddit, title, body, replyToExternalId }) => {
      const props = agent.props;
      requirePublishPermission(props, "reddit_post");
      const userId = requireUserId(props, "RedditMcpAgent");

      const channel = requireChannel(
        await getChannel(agent.bindings, userId, "reddit"),
        "Reddit",
      );

      const isComment = Boolean(replyToExternalId);
      const endpoint = isComment
        ? "https://oauth.reddit.com/api/comment"
        : "https://oauth.reddit.com/api/submit";

      const formBody = new URLSearchParams();
      formBody.set("api_type", "json");
      if (isComment) {
        // Normalize bare ids → `t3_<id>` (submission fullname). Reddit
        // search currently returns submission ids only; comments on
        // comments would arrive as `t1_<id>` from a future surface.
        const fullname = replyToExternalId!.startsWith("t")
          ? replyToExternalId!
          : `t3_${replyToExternalId}`;
        formBody.set("thing_id", fullname);
        formBody.set("text", body);
      } else {
        if (!title) {
          throw new Error(
            "reddit_post: `title` is required when posting a new submission " +
              "(omit `replyToExternalId` only when also providing `title`).",
          );
        }
        formBody.set("sr", subreddit);
        formBody.set("title", title);
        formBody.set("kind", "self");
        formBody.set("text", body);
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "shipflare-cf/1.0 (https://shipflare.com)",
        },
        body: formBody,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(
          `Reddit post failed (${res.status}): ${errText.slice(0, 500)}`,
        );
      }

      let result: RedditSubmitResponse;
      try {
        result = (await res.json()) as RedditSubmitResponse;
      } catch (err) {
        throw new Error(
          `Reddit post returned 2xx but unparseable JSON: ${String(err)}`,
        );
      }

      // Reddit's `api_type=json` wraps errors in `json.errors` even on
      // 2xx. Empty array → success. Non-empty → app-layer error
      // (rate-limited, deleted-parent, banned-domain, etc.).
      const errors = result.json?.errors ?? [];
      if (Array.isArray(errors) && errors.length > 0) {
        throw new Error(
          `Reddit API errors: ${JSON.stringify(errors).slice(0, 500)}`,
        );
      }

      // Submission responses populate `things[0].data.name` /`.id` /
      // `.url`. Comment responses populate the same shape under the
      // same `things[0].data` envelope. Fall back to "unknown" if
      // Reddit changes the shape — the row still lands in
      // posted_externals so audits notice the drift.
      const thing = result.json?.data?.things?.[0]?.data;
      const id = thing?.name ?? thing?.id ?? "unknown";
      const url =
        thing?.url ??
        `https://www.reddit.com/r/${subreddit}/comments/${stripFullnamePrefix(id)}`;

      // Persist to posted_externals. INSERT OR REPLACE handles retry
      // semantics — same fullname surfaces here only on a redrive of
      // a partial failure, never as a duplicate.
      agent.sqlStorage.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        isComment ? "reply" : "post",
        props?.role ?? props?.caller ?? "unknown",
        Date.now(),
        JSON.stringify(thing ?? result.json),
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, url }),
          },
        ],
      };
    },
  );
}

/**
 * Drop the `t<digit>_` fullname prefix Reddit attaches to ids before
 * embedding in URL paths. `t3_abc` → `abc`. Idempotent when no prefix
 * is present.
 */
function stripFullnamePrefix(fullname: string): string {
  return fullname.replace(/^t\d+_/, "");
}

interface RedditSubmitResponse {
  json?: {
    errors?: unknown[];
    data?: {
      things?: Array<{
        data?: {
          id?: string;
          name?: string;
          url?: string;
        };
      }>;
    };
  };
}
