import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { CommunityManager } from "../CommunityManager";

/**
 * chat — direct conversation surface for the Community Manager.
 *
 * Pulls founder_context from the CMO via RPC and answers in a
 * community-manager persona: pulse-aware, tone-aware, focused on what the
 * audience is actually saying right now. Phase 2 P2-B is single-turn;
 * multi-turn transcripts land in Phase 2.x.
 */
export function registerChatTool(agent: CommunityManager): void {
  agent.server.registerTool(
    "chat",
    {
      description:
        "Talk to the Community Manager about audience sentiment, recurring " +
        "mentions, and community engagement strategy.",
      inputSchema: {
        conversationId: z.string().min(1).optional(),
        message: z.string().min(1),
      },
    },
    async ({ message }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error(
          "CommunityManager has no userId in props; cannot chat",
        );
      }

      const cmoServerName = mcpServerName("cmo", userId);
      const cmo = agent.mcp
        .listServers()
        .find((s) => s.name === cmoServerName);
      let ctx: Record<string, string> = {};
      if (cmo) {
        try {
          const result = await agent.mcp.callTool({
            serverId: cmo.id,
            name: "queryFounderContext",
            arguments: {},
          });
          ctx = JSON.parse(extractText(result)) as Record<string, string>;
        } catch (err) {
          console.warn(
            `[CommunityManager ${userId}] queryFounderContext failed:`,
            err,
          );
        }
      }

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: `You are the Community Manager for ${ctx.productName ?? "the product"}.
Audience: ${ctx.audience ?? "(not yet defined)"}
Voice: ${ctx.voice ?? "casual"}

Focus on community pulse — what's the audience saying, what's working, what's
landing flat, who's a recurring voice, where the trolls are. Be specific and
opinionated. If asked to draft a reply, prefer disarming directness over
corporate softness.`,
        messages: [{ role: "user", content: message }],
      });

      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("");

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
