import { z } from "zod";
import { mcpServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import { logPeerDmShadow } from "../../../lib/peer-dm-shadow";
import type { SocialMediaMgr } from "../SocialMediaMgr";

/**
 * polishWithCopywriter — P2-C peer-DM exemplar.
 *
 * SMM calls Copywriter.rewriteInVoice via in-process MCP RPC and then logs
 * a quiet shadow at the CMO so the CMO has visibility into peer-DMs
 * WITHOUT being woken (spec §6.1 invariant #2). The shadow append goes to
 * CMO's `/internal/peer-dm-shadow` HTTP route via the shared
 * `logPeerDmShadow` helper — not through MCP/chat — which guarantees the
 * CMO's onMessage / chat handler is not triggered.
 *
 * Returns the rewritten body + one-line rationale. If shadow logging
 * fails we still return the rewrite (shadow failure is non-fatal).
 */
export function registerPolishWithCopywriterTool(agent: SocialMediaMgr): void {
  agent.server.registerTool(
    "polishWithCopywriter",
    {
      description:
        "Send a draft body to the Copywriter for a voice-aligned rewrite. " +
        "Returns the rewritten body plus a short rationale. Logs a peer-DM " +
        "shadow to CMO (silent — does not wake the CMO chat loop).",
      inputSchema: {
        conversationId: z
          .string()
          .optional()
          .describe(
            "Optional CMO conversation id used to correlate the shadow log.",
          ),
        body: z
          .string()
          .min(1)
          .describe("The draft body to send to Copywriter for rewriting."),
      },
    },
    async ({ conversationId, body }) => {
      const userId = agent.props?.userId;
      if (!userId) {
        throw new Error("SMM has no userId; cannot polish with Copywriter");
      }

      // Locate the Copywriter peer connection. SMM eager-connects in
      // connectToPeers(); if the founder hasn't hired Copywriter yet, the
      // call below will surface a clear error rather than silently failing.
      const copywriterServerName = mcpServerName("copywriter", userId);
      const copywriter = agent.mcp
        .listServers()
        .find((s) => s.name === copywriterServerName);
      if (!copywriter) {
        throw new Error(
          "Copywriter not connected. Hire them via CMO.hireEmployee.",
        );
      }

      // 1) RPC the rewrite. Surfaced errors propagate to the caller.
      const rewriteResult = await agent.mcp.callTool({
        serverId: copywriter.id,
        name: "rewriteInVoice",
        arguments: { body },
      });
      const parsed = JSON.parse(extractText(rewriteResult)) as {
        body: string;
        whyItWorks?: string;
      };

      // 2) Shadow log to CMO — silent, no chat trigger. Non-fatal on error.
      const cmoBinding = (agent.bindings as unknown as Record<string, unknown>)
        .CMO as DurableObjectNamespace | undefined;
      if (cmoBinding) {
        try {
          await logPeerDmShadow(cmoBinding, userId, {
            conversationId,
            fromRole: "social-media-manager",
            toRole: "copywriter",
            tool: "rewriteInVoice",
            summary: `SMM polished ${body.length}-char draft via Copywriter`,
            payload: {
              originalLength: body.length,
              rewrittenLength: parsed.body.length,
            },
          });
        } catch (err) {
          console.warn(
            `[SMM ${userId}] peer-DM shadow failed (non-fatal):`,
            err,
          );
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              body: parsed.body,
              whyItWorks: parsed.whyItWorks ?? null,
            }),
          },
        ],
      };
    },
  );
}
