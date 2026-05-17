import { z } from "zod";
import { runSkill } from "@shipflare/skills";
import { mcpServerName, platformServerName } from "@shipflare/shared";
import { extractText } from "../lib/mcp-result";
import type { SocialMediaMgr } from "../SocialMediaMgr";
import {
  extractTrace,
  withSubAgentToolTracing,
} from "../../../lib/subagent-activity";

/**
 * find_threads_via_xai — dual-platform thread discovery + judging pipeline.
 *
 * Called by CMO via `delegateToEmployee` when:
 *   - Founder asks for inbound discovery ("find what people are saying about X")
 *   - Cron tick triggers periodic sweep
 *   - Plan item with skill='discovery' fires
 *
 * Flow:
 *   1. RPC CMO.queryFounderContext for product details
 *   2. RPC platform MCP (X or Reddit) for raw threads matching intent
 *   3. runSkill("judging-thread") to score each thread for engagement value
 *   4. Persist qualifying ones to SMM.threads_inbox
 *   5. Return summary
 *
 * Per spec §6.1: SMM never writes CMO SQLite directly. founder_context
 * comes from CMO via RPC.
 *
 * S6.1: the judging prompt has been lifted to packages/skills/judging-thread
 * and is invoked via `runSkill`. The inline `judgeThreadsBatch` + parse helper
 * are gone — the runner handles model selection, placeholder substitution, and
 * JSON parsing.
 *
 * Forward-compat: X_MCP / REDDIT_MCP don't exist yet (S5 lands them).
 * When the platform server isn't connected, return a clear "not yet
 * deployed" error instead of crashing. The tool will be useful as soon
 * as S5 ships.
 */
export function registerFindThreadsViaXaiTool(agent: SocialMediaMgr): void {
  agent.server.registerTool(
    "find_threads_via_xai",
    {
      description:
        "Discover engagement-worthy threads on a platform via xAI/Grok search " +
        "(X) or web_search (Reddit). Each candidate is LLM-judged for product " +
        "fit + engagement value. Qualifying threads land in threads_inbox.",
      inputSchema: {
        conversationId: z.string().min(1),
        platform: z.enum(["x", "reddit"]).default("x"),
        intent: z
          .string()
          .optional()
          .describe(
            "Free-form intent hint (e.g. 'product-mention-engagement', " +
              "'competitor-watch', 'hourly-sweep'). Defaults to 'engagement'.",
          ),
        maxResults: z.number().int().min(1).max(50).default(20),
        _trace: z.unknown().optional(),
      },
    },
    async (args) => {
      const trace = extractTrace(args);
      const { platform, intent, maxResults } = args as {
        platform: "x" | "reddit";
        intent?: string;
        maxResults: number;
      };
      return withSubAgentToolTracing(
        agent.runtimeCtx,
        agent.bindings,
        trace,
        "social-media-manager",
        "find_threads_via_xai",
        args,
        async () => {
          const userId = agent.props?.userId;
          if (!userId)
            throw new Error("SMM has no userId; cannot run discovery");

          const intentResolved = intent ?? "engagement";

          // Step 1: pull founder_context via CMO RPC
          const cmoServerName = mcpServerName("cmo", userId);
          const cmo = agent.mcp
            .listServers()
            .find((s) => s.name === cmoServerName);

          let founderContext: Record<string, string> = {};
          if (cmo) {
            try {
              const result = await agent.mcp.callTool({
                serverId: cmo.id,
                name: "queryFounderContext",
                arguments: {},
              });
              founderContext = JSON.parse(extractText(result)) as Record<
                string,
                string
              >;
            } catch (err) {
              console.warn(`[SMM ${userId}] queryFounderContext failed:`, err);
            }
          }

          const product = founderContext.productName ?? "(product not set)";
          const productDescription = founderContext.productDescription ?? "";

          // Step 2: find the platform MCP and call its search tool.
          // Server name shape comes from platformServerName(platform, userId)
          // → "x-mcp-${userId}" / "reddit-mcp-${userId}", matching the dial in
          // SocialMediaMgr.connectToPeers().
          const platformServerKey = platformServerName(platform, userId);
          const platformServer = agent.mcp
            .listServers()
            .find((s) => s.name === platformServerKey);
          if (!platformServer) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    queued: 0,
                    scanned: 0,
                    platform,
                    error: `${platform.toUpperCase()}_MCP not yet deployed (S5). Try again after S5 lands.`,
                  }),
                },
              ],
            };
          }

          // Platform tool names: "x_search" / "reddit_search" (S5 will register
          // these on the X_MCP / REDDIT_MCP Durable Objects). Names follow the
          // existing namespace convention noted in CLAUDE.md ("tools are
          // namespaced by platform: reddit_search, x_post"). Documented here
          // because S5 has not yet landed the canonical contract.
          const searchToolName =
            platform === "x" ? "x_search" : "reddit_search";
          let rawThreads: Array<{
            externalId: string;
            author?: string;
            content: string;
          }> = [];
          try {
            const searchResult = await agent.mcp.callTool({
              serverId: platformServer.id,
              name: searchToolName,
              arguments: {
                product,
                productDescription,
                intent: intentResolved,
                maxResults,
              },
            });
            rawThreads = JSON.parse(
              extractText(searchResult),
            ) as typeof rawThreads;
          } catch (err) {
            console.error(
              `[SMM ${userId}] platform search ${searchToolName} failed:`,
              err,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    queued: 0,
                    scanned: 0,
                    platform,
                    error: `${searchToolName} call failed: ${String(err)}`,
                  }),
                },
              ],
            };
          }

          // Step 3: judge threads via `judging-thread` skill. Single batched call
          // returns an array aligned positionally with the input.
          let judgements: Array<{
            keep: boolean;
            score: number;
            reason: string;
          }> = [];
          if (rawThreads.length > 0) {
            try {
              const raw = await runSkill<unknown>({
                name: "judging-thread",
                args: {
                  product,
                  productDescription: productDescription || "(not provided)",
                  threads: JSON.stringify(rawThreads, null, 2),
                },
                env: { ANTHROPIC_API_KEY: agent.bindings.ANTHROPIC_API_KEY },
              });
              if (Array.isArray(raw)) {
                judgements = raw
                  .filter(
                    (j): j is Record<string, unknown> =>
                      typeof j === "object" && j !== null,
                  )
                  .map((j) => ({
                    keep: j.keep === true,
                    score: typeof j.score === "number" ? j.score : 0,
                    reason: typeof j.reason === "string" ? j.reason : "",
                  }))
                  .slice(0, rawThreads.length);
              }
            } catch (err) {
              console.error(
                `[SMM ${userId}] judging-thread skill failed:`,
                err,
              );
            }
          }

          // Zip judgements onto input threads (parse_failed fallback when the
          // runner returned a non-array shape).
          const judged = rawThreads.map((t, i) => {
            const j = judgements[i] ?? {
              keep: false,
              score: 0,
              reason: "parse_failed",
            };
            return {
              externalId: t.externalId,
              author: t.author,
              content: t.content,
              keep: j.keep,
              score: j.score,
              reason: j.reason,
            };
          });

          // Step 4: persist qualifying threads to threads_inbox
          const now = Date.now();
          const expiresAt = now + 24 * 60 * 60 * 1000; // 24h soft TTL
          let queued = 0;
          const topQueued: Array<{
            externalId: string;
            score: number;
            content: string;
          }> = [];

          for (const j of judged) {
            if (!j.keep) continue;
            const id = crypto.randomUUID();
            agent.sqlStorage.exec(
              `INSERT OR REPLACE INTO threads_inbox
             (id, platform, external_id, author, content, score, judged_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              id,
              platform,
              j.externalId,
              j.author ?? null,
              j.content,
              j.score,
              now,
              expiresAt,
            );
            queued++;
            if (topQueued.length < 3) {
              topQueued.push({
                externalId: j.externalId,
                score: j.score,
                content: j.content,
              });
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  queued,
                  scanned: rawThreads.length,
                  platform,
                  intent: intentResolved,
                  topQueued,
                }),
              },
            ],
          };
        },
      );
    },
  );
}
