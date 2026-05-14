import { z } from "zod";
import { getChannel } from "../../../../lib/channel";
import type { LinkedInMcpAgent } from "../LinkedInMcpAgent";
import {
  requireChannel,
  requirePublishPermission,
  requireUserId,
} from "../../_shared/guards";

/**
 * linkedin_post — publish a text-only UGC Post on behalf of the
 * OAuth-bound LinkedIn member.
 *
 * Role-gated: only `role='lead'` or `caller='external'` may invoke this.
 * Members (SMM workers, peer agents) can only DRAFT — see
 * `_shared/guards.ts:requirePublishPermission`.
 *
 * OAuth: token loaded via `getChannel(env, userId, "linkedin")` — the
 * single sanctioned reader of `channels.oauth_token_encrypted`
 * (CLAUDE.md Security TODO §1). The token must carry the
 * `w_member_social` + `r_liteprofile` scopes (requested in the connect
 * route's authorize URL).
 *
 * Endpoint: `POST https://api.linkedin.com/v2/ugcPosts` with the
 * Marketing Developer Platform UGC shape:
 *
 *   {
 *     "author": "urn:li:person:<externalUserId>",
 *     "lifecycleState": "PUBLISHED",
 *     "specificContent": {
 *       "com.linkedin.ugc.ShareContent": {
 *         "shareCommentary": { "text": body },
 *         "shareMediaCategory": "NONE"
 *       }
 *     },
 *     "visibility": {
 *       "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
 *     }
 *   }
 *
 * Required headers (LinkedIn quirk):
 *   - `X-Restli-Protocol-Version: 2.0.0` — LinkedIn defaults to v1.0.0
 *     which doesn't support the URN format above. Skipping this header
 *     yields a cryptic 400.
 *   - `LinkedIn-Version: 202401` — optional but recommended; pins the
 *     UGC schema so a LinkedIn-side bump doesn't silently break us.
 *
 * Response: `x-restli-id` HEADER holds the new post's URN (e.g.
 * `urn:li:share:7000000000000000000`). Body is an empty object on
 * success. We persist the URN as the `external_id` for idempotency.
 *
 * Idempotency: INSERT OR REPLACE on `posted_externals` keyed on the
 * URN. A retry from the same caller produces a fresh URN from LinkedIn
 * (no idempotency key in the API), so practical idempotency lives in
 * the caller's pre-check + this tool's post-write mirror.
 */
export function registerLinkedInPostTool(agent: LinkedInMcpAgent): void {
  agent.server.registerTool(
    "linkedin_post",
    {
      description:
        "Publish a text-only UGC Post to LinkedIn. Role-gated: requires " +
        "role='lead' or caller='external'. Requires r_liteprofile + " +
        "w_member_social scopes on the OAuth token.",
      inputSchema: {
        body: z.string().min(1).max(3000),
      },
    },
    async ({ body }) => {
      const props = agent.props;
      requirePublishPermission(props, "linkedin_post");
      const userId = requireUserId(props, "LinkedInMcpAgent");

      const channel = requireChannel(
        await getChannel(agent.bindings, userId, "linkedin"),
        "LinkedIn",
      );

      const apiBody = {
        author: `urn:li:person:${channel.externalUserId}`,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: body },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
      };

      const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          "Content-Type": "application/json",
          // Restli v2 is required for the URN shape in `author`.
          "X-Restli-Protocol-Version": "2.0.0",
          // Pin the UGC schema version so LinkedIn-side changes don't
          // silently break us. Bump when LinkedIn announces a new GA.
          "LinkedIn-Version": "202401",
        },
        body: JSON.stringify(apiBody),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(
          `LinkedIn post failed (${res.status}): ${errText.slice(0, 500)}`,
        );
      }

      // LinkedIn returns the new URN in the `x-restli-id` response
      // header. Body is `{}` on success. Some legacy deployments also
      // return an `id` field in the body — try header first, fall back
      // to body, fall back to "unknown" so the audit row still lands.
      const urnFromHeader = res.headers.get("x-restli-id");
      let urn = urnFromHeader ?? "unknown";
      let responseBody: unknown = null;
      try {
        responseBody = await res.json();
        if (
          !urnFromHeader &&
          responseBody !== null &&
          typeof responseBody === "object" &&
          "id" in responseBody &&
          typeof (responseBody as { id?: unknown }).id === "string"
        ) {
          urn = (responseBody as { id: string }).id;
        }
      } catch {
        // Empty / non-JSON body is fine for UGC posts — the URN header
        // is the canonical id.
      }

      // Persist to posted_externals. INSERT OR REPLACE handles retry
      // semantics — same URN surfaces here only on a redrive of a
      // partial failure, never as a duplicate.
      agent.sqlStorage.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        urn,
        "post",
        props?.role ?? props?.caller ?? "unknown",
        Date.now(),
        JSON.stringify({ urn, response: responseBody, request: apiBody }),
      );

      // LinkedIn post URLs are derived from the share URN's numeric
      // suffix. The full pattern is
      // `https://www.linkedin.com/feed/update/<urn>`.
      const url = `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}`;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: urn, url }),
          },
        ],
      };
    },
  );
}
