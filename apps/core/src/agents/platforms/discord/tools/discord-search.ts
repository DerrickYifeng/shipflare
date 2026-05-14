import { z } from "zod";
import type { DiscordMcpAgent } from "../DiscordMcpAgent";

/**
 * discord_search — placeholder.
 *
 * Discord bots cannot "search" channels broadly. The closest API is
 * `GET /channels/{channel.id}/messages?around=` which requires
 * `READ_MESSAGE_HISTORY` permission per-channel and only fetches a
 * single channel's history at a time. There is no cross-server,
 * cross-channel message-search endpoint for bots.
 *
 * Phase 2 P2-E ships this as a documented stub so SMM's discovery
 * loop sees a consistent tool surface across platforms (it can call
 * `discord_search` without checking whether the platform "supports
 * search"). The empty array signals "no discoverable threads".
 *
 * Phase 2 P2-E.2 follow-up options:
 *   1. Per-channel scan: founder configures a list of channel ids,
 *      we poll `GET /channels/{id}/messages` for each on a cadence.
 *   2. Webhook-driven inbox: founder configures a Discord webhook
 *      that pushes new messages to ShipFlare; we react inline.
 *   3. Slash-command surface: bot exposes `/help` that founders
 *      invoke directly — pull-based instead of search.
 */
export function registerDiscordSearchTool(agent: DiscordMcpAgent): void {
  agent.server.registerTool(
    "discord_search",
    {
      description:
        "Search Discord messages (STUB — Discord bots have no cross-channel " +
        "search API; returns empty array with note).",
      inputSchema: {
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).default(20),
      },
    },
    async () => {
      void agent;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              threads: [],
              note:
                "Discord has no broad message-search API for bots. " +
                "Phase 2 P2-E.2 will add per-channel polling or webhook-driven " +
                "inbox. Founders can still publish via discord_post.",
            }),
          },
        ],
      };
    },
  );
}
