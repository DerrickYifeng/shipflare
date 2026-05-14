import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import type { SocialMediaMgr } from "../SocialMediaMgr";

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
 *   3. Anthropic-judge each thread for engagement value
 *   4. Persist qualifying ones to SMM.threads_inbox
 *   5. Return summary
 *
 * Per spec §6.1: SMM never writes CMO SQLite directly. founder_context
 * comes from CMO via RPC.
 *
 * Per S6: the judging prompt here is INLINE for Phase 1. S6 ports it to
 * packages/skills/judging-thread/SKILL.md and the call becomes a skill
 * runner invocation.
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
      },
    },
    async ({ platform, intent, maxResults }) => {
      const userId = agent.props?.userId;
      if (!userId) throw new Error("SMM has no userId; cannot run discovery");

      const intentResolved = intent ?? "engagement";

      // Step 1: pull founder_context via CMO RPC
      const cmoServerName = mcpServerName("cmo", userId);
      const cmo = agent.mcp.listServers().find((s) => s.name === cmoServerName);

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
      // Server name shape matches mcpServerName("<platform>-mcp", userId)
      // → "x-mcp-${userId}" / "reddit-mcp-${userId}", matching the dial in
      // SocialMediaMgr.connectToPeers().
      const platformServerName = `${platform}-mcp-${userId}`;
      const platformServer = agent.mcp
        .listServers()
        .find((s) => s.name === platformServerName);
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
      const searchToolName = platform === "x" ? "x_search" : "reddit_search";
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
        rawThreads = JSON.parse(extractText(searchResult)) as typeof rawThreads;
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

      // Step 3: Anthropic-judge each thread. Single batched call (cheaper than
      // N calls). Inline prompt — full skill port lands in S6.
      const judged = await judgeThreadsBatch(
        agent.bindings.ANTHROPIC_API_KEY,
        {
          product,
          productDescription,
          threads: rawThreads,
        },
      );

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
}

/**
 * Extract the text content from an MCP tool result. Tools return
 * `{ content: [{ type: "text", text: "..." }, ...] }`. This walks the
 * array and concatenates text blocks.
 */
function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r.content) return "";
  return r.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

/**
 * Judge a batch of threads in a single LLM call.
 *
 * Cost shape: 1 LLM call per find_threads_via_xai invocation, regardless of
 * thread count (vs. N calls in the naïve approach). The model returns an
 * array of judgements aligned positionally with the input.
 *
 * Phase 1 inline prompt; S6 lifts to packages/skills/judging-thread/SKILL.md.
 */
async function judgeThreadsBatch(
  apiKey: string,
  input: {
    product: string;
    productDescription: string;
    threads: Array<{ externalId: string; author?: string; content: string }>;
  },
): Promise<
  Array<{
    externalId: string;
    author?: string;
    content: string;
    keep: boolean;
    score: number;
    reason: string;
  }>
> {
  if (input.threads.length === 0) return [];

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: `You are judging social media threads for engagement value on behalf of ${input.product}.

Context:
- Product: ${input.product}
- Description: ${input.productDescription || "(not provided)"}

For each thread, decide:
- keep: true|false — should we engage?
- score: 0-1 confidence — how good a fit is this?
- reason: 1-line why

Keep when: the thread is a genuine question, complaint, or discussion where
our product is a natural mention (NOT a forced ad opportunity).
Skip when: thread is a generic ad, off-topic, spammy, or our mention would
feel forced.

Output ONLY a JSON array inside a \`\`\`json code block, aligned positionally with the input:
\`\`\`json
[
  { "keep": true, "score": 0.85, "reason": "founder asking exactly our use case" }
]
\`\`\``,
    messages: [
      {
        role: "user",
        content: `Judge these ${input.threads.length} threads:\n\n${JSON.stringify(input.threads, null, 2)}`,
      },
    ],
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const judgements = parseJudgements(text, input.threads.length);

  // Zip judgements onto input threads
  return input.threads.map((t, i) => {
    const j = judgements[i] ?? { keep: false, score: 0, reason: "parse_failed" };
    return {
      externalId: t.externalId,
      author: t.author,
      content: t.content,
      keep: j.keep,
      score: j.score,
      reason: j.reason,
    };
  });
}

function parseJudgements(
  text: string,
  expectedCount: number,
): Array<{ keep: boolean; score: number; reason: string }> {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (j): j is Record<string, unknown> =>
          typeof j === "object" && j !== null,
      )
      .map((j) => ({
        keep: j.keep === true,
        score: typeof j.score === "number" ? j.score : 0,
        reason: typeof j.reason === "string" ? j.reason : "",
      }))
      .slice(0, expectedCount);
  } catch {
    return [];
  }
}
