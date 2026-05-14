import { z } from "zod";
import { getChannel } from "../../../../lib/channel";
import type { DiscordMcpAgent } from "../DiscordMcpAgent";
import {
  requireChannel,
  requirePublishPermission,
  requireUserId,
} from "../../_shared/guards";

/**
 * discord_post — send a message to a Discord text channel as the
 * configured bot user.
 *
 * Role-gated: only `role='lead'` or `caller='external'` may invoke this.
 * Members (SMM workers, peer agents) can only DRAFT — see
 * `_shared/guards.ts:requirePublishPermission`.
 *
 * Auth shape: Discord bot tokens are NOT OAuth — they are long-lived
 * secrets ("Bot <token>" prefix instead of "Bearer"). Phase 2 P2-E
 * stores the bot token in `channels.oauthTokenEncrypted` so it rides
 * the same envelope-encryption + `getChannel` decrypt path as the
 * OAuth-bearing platforms. The `oauthRefreshEncrypted` column is null.
 *
 * Phase 2 P2-E.2 follow-up: replace the lo-fi form-POST connect flow
 * with the real Discord OAuth bot install (Authorize → Add to Server →
 * Permissions grant) so the founder can manage scope from inside
 * Discord rather than copy-pasting a token.
 *
 * Endpoint: `POST https://discord.com/api/v10/channels/{channelId}/messages`
 * with `{ "content": "<body>" }`. Discord enforces a 2000-char limit
 * on `content` for non-Nitro accounts — we cap at 2000 in the schema.
 *
 * Rate limits: Discord uses per-route + global buckets. We don't yet
 * cache them in `rate_limits` (Phase 2 P2-E.2) — for now we just
 * surface 429s as hard errors with the response body so the caller
 * can back off.
 *
 * Idempotency: INSERT OR REPLACE on `posted_externals` keyed on the
 * snowflake message id returned by Discord. Discord's API has no
 * native idempotency-key support; retries from the same caller would
 * produce duplicate messages, so practical idempotency lives in the
 * caller's pre-check.
 */
export function registerDiscordPostTool(agent: DiscordMcpAgent): void {
  agent.server.registerTool(
    "discord_post",
    {
      description:
        "Send a message to a Discord text channel via the configured bot. " +
        "Role-gated: requires role='lead' or caller='external'.",
      inputSchema: {
        // Snowflake ids are 64-bit unsigned integers serialized as
        // decimal strings (17-20 digits in practice). Validate length
        // loosely — Discord can extend snowflakes — but reject empty.
        channelId: z.string().min(1).max(32),
        body: z.string().min(1).max(2000),
      },
    },
    async ({ channelId, body }) => {
      const props = agent.props;
      requirePublishPermission(props, "discord_post");
      const userId = requireUserId(props, "DiscordMcpAgent");

      const channel = requireChannel(
        await getChannel(agent.bindings, userId, "discord"),
        "Discord",
      );

      const res = await fetch(
        `https://discord.com/api/v10/channels/${encodeURIComponent(
          channelId,
        )}/messages`,
        {
          method: "POST",
          headers: {
            // Discord bot tokens use the `Bot <token>` scheme, not `Bearer`.
            Authorization: `Bot ${channel.accessToken}`,
            "Content-Type": "application/json",
            // Discord requires a User-Agent that identifies the bot.
            "User-Agent": "shipflare-cf/1.0 (https://shipflare.com)",
          },
          body: JSON.stringify({ content: body }),
        },
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        throw new Error(
          `Discord post failed (${res.status}): ${errText.slice(0, 500)}`,
        );
      }

      const message = (await res.json()) as {
        id: string;
        channel_id: string;
        guild_id?: string;
      };

      // Persist to posted_externals. INSERT OR REPLACE handles retry
      // semantics — same snowflake surfaces here only on a redrive of
      // a partial failure, never as a duplicate.
      agent.sqlStorage.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        message.id,
        "post",
        props?.role ?? props?.caller ?? "unknown",
        Date.now(),
        JSON.stringify(message),
      );

      // Discord message URLs are
      // `https://discord.com/channels/<guild>/<channel>/<message>`.
      // DMs (no guild) are `@me/<channel>/<message>`.
      const guildSegment = message.guild_id ?? "@me";
      const url = `https://discord.com/channels/${guildSegment}/${message.channel_id}/${message.id}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: message.id, url }),
          },
        ],
      };
    },
  );
}
