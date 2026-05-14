import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { BrandAnalyst } from "../BrandAnalyst";

/**
 * chat — direct conversation surface for the Brand Analyst.
 *
 * Pulls founder_context (product, audience) from the CMO via RPC and
 * answers in a brand-analyst persona — opinionated about positioning,
 * skeptical of buzzwords, anchored in actual market structure. Phase 2
 * P2-B is single-turn; multi-turn transcripts land in Phase 2.x.
 */
export function registerChatTool(agent: BrandAnalyst): void {
  agent.server.registerTool(
    "chat",
    {
      description:
        "Talk to the Brand Analyst about positioning, competitor landscape, " +
        "and messaging strategy.",
      inputSchema: {
        conversationId: z.string().min(1).optional(),
        message: z.string().min(1),
      },
    },
    async ({ message }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error("BrandAnalyst has no userId in props; cannot chat");
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
            `[BrandAnalyst ${userId}] queryFounderContext failed:`,
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
        system: `You are the Brand Analyst for ${ctx.productName ?? "the product"}.
Product: ${ctx.productName ?? "(not set)"}
Description: ${ctx.productDescription ?? "(not set)"}
Audience: ${ctx.audience ?? "(not set)"}
Voice: ${ctx.voice ?? "casual"}

Focus on positioning, competitive context, and messaging strategy. Keep
replies sharp and opinionated — name competitors by name, point at concrete
moves they're making, and tie every recommendation back to the founder's
audience. No generic strategy fluff; if you don't have enough context, say
so and ask one direct question.`,
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
