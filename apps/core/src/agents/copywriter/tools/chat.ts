import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { Copywriter } from "../Copywriter";

/**
 * chat — direct conversation surface for the Copywriter.
 *
 * Pulls founder_context from the CMO via RPC for product-aware voice and
 * answers in a copywriter persona (sharp, opinionated, draft-first). Phase
 * 2 P2-B keeps this shallow: a single Anthropic call, no transcript
 * persistence yet (the founder UI surfaces the CMO chat as the main
 * conversation; Copywriter chat is a focused sidecar). Multi-turn
 * persistence lands in Phase 2.x.
 */
export function registerChatTool(agent: Copywriter): void {
  agent.server.registerTool(
    "chat",
    {
      description:
        "Talk to the Copywriter about headlines, taglines, post copy, and " +
        "rewrites. Returns draft language in the founder's voice.",
      inputSchema: {
        conversationId: z.string().min(1).optional(),
        message: z.string().min(1),
      },
    },
    async ({ message }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error("Copywriter has no userId in props; cannot chat");
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
            `[Copywriter ${userId}] queryFounderContext failed:`,
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
        system: `You are the Copywriter for ${ctx.productName ?? "the product"}.
Voice: ${ctx.voice ?? "casual, no marketing fluff"}.
Audience: ${ctx.audience ?? "(audience not yet defined)"}.
Focus on tight, opinionated copy — headlines, taglines, hooks, rewrites. Keep
replies sharp; show drafts before commentary; never use generic marketing
buzzwords ("game-changer", "unlock", "revolutionize", "seamless"). When asked
to generate options, hand back a short list, not a paragraph.`,
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
