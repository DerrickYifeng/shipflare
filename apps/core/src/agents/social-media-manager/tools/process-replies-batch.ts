import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { mcpServerName } from "@shipflare/shared";
import { validateDraft } from "../lib/validators";
import { extractText } from "../lib/mcp-result";
import type { SocialMediaMgr } from "../SocialMediaMgr";

/**
 * process_replies_batch — draft replies for a batch of thread ids.
 *
 * Called by CMO via delegateToEmployee after find_threads_via_xai surfaces
 * candidates worth replying to.
 *
 * Per thread:
 *   1. Read from threads_inbox
 *   2. Pull founder_context (voice + product) from CMO RPC
 *   3. Anthropic-draft a reply (inline drafting prompt — S6 ports proper)
 *   4. Validate: platform-leak + length limits (S6 ports throttle too)
 *   5. Persist to drafts table (status='ready' if valid; 'failed' if not)
 *
 * Returns: { itemsScanned, draftsCreated, draftsSkipped, notes: [...] }
 */
export function registerProcessRepliesBatchTool(agent: SocialMediaMgr): void {
  agent.server.registerTool(
    "process_replies_batch",
    {
      description:
        "Draft replies for a batch of thread ids. Reads each thread, drafts " +
        "via LLM in the founder's voice, validates platform-leak + length, " +
        "persists to drafts table. Returns batch summary.",
      inputSchema: {
        conversationId: z.string().min(1),
        threadIds: z.array(z.string().min(1)).min(1).max(50),
        voiceOverride: z
          .string()
          .optional()
          .describe(
            "Override the founder_context.voice with a one-off instruction. " +
              "Use sparingly; the default voice should win in production.",
          ),
      },
    },
    async ({ conversationId, threadIds, voiceOverride }) => {
      const userId = agent.props?.userId;
      if (!userId) throw new Error("SMM has no userId; cannot draft replies");

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
      const voice =
        voiceOverride ??
        founderContext.voice ??
        "casual, direct, no marketing fluff";

      // Step 2: process each thread
      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      let draftsCreated = 0;
      let draftsSkipped = 0;
      const notes: string[] = [];

      for (const threadId of threadIds) {
        const threadRow = agent.sqlStorage
          .exec<{
            platform: string;
            external_id: string;
            author: string | null;
            content: string;
          }>(
            "SELECT platform, external_id, author, content FROM threads_inbox WHERE id = ?",
            threadId,
          )
          .toArray()[0];

        if (!threadRow) {
          draftsSkipped++;
          notes.push(`${threadId}: not in inbox`);
          continue;
        }

        const platform = threadRow.platform as "x" | "reddit";

        // Step 3: draft the reply via Anthropic
        let draftBody = "";
        let whyItWorks = "";
        let confidence = 0;
        try {
          const draft = await draftReply(client, {
            product,
            productDescription,
            voice,
            thread: threadRow,
            platform,
          });
          draftBody = draft.body;
          whyItWorks = draft.whyItWorks;
          confidence = draft.confidence;
        } catch (err) {
          draftsSkipped++;
          notes.push(`${threadId}: LLM failed: ${String(err)}`);
          continue;
        }

        // Step 4: validate
        const validation = validateDraft(draftBody, platform);
        const draftId = crypto.randomUUID();
        const now = Date.now();
        const status = validation.ok ? "ready" : "failed";

        agent.sqlStorage.exec(
          `INSERT INTO drafts
             (conversation_id, id, kind, plan_item_id, platform, thread_id, body,
              why_it_works, confidence, status, audit_notes_json, created_at, updated_at)
           VALUES (?, ?, 'reply', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          conversationId,
          draftId,
          platform,
          threadId,
          draftBody,
          whyItWorks || null,
          confidence,
          status,
          JSON.stringify({ validation }),
          now,
          now,
        );

        if (validation.ok) {
          draftsCreated++;
        } else {
          draftsSkipped++;
          notes.push(
            `${threadId}: validation failed: ${validation.reasons.join("; ")}`,
          );
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              itemsScanned: threadIds.length,
              draftsCreated,
              draftsSkipped,
              notes,
            }),
          },
        ],
      };
    },
  );
}

/**
 * Draft a single reply via Anthropic.
 *
 * Phase 1 inline prompt; S6 lifts to packages/skills/drafting-reply/SKILL.md.
 */
async function draftReply(
  client: Anthropic,
  input: {
    product: string;
    productDescription: string;
    voice: string;
    thread: { platform: string; author: string | null; content: string };
    platform: "x" | "reddit";
  },
): Promise<{ body: string; whyItWorks: string; confidence: number }> {
  const lengthHint = input.platform === "x" ? "≤ 280 chars" : "≤ 1000 chars";

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are drafting a reply on behalf of ${input.product} (${input.productDescription || "no description"}).

Voice: ${input.voice}

You're replying to a real person on ${input.platform.toUpperCase()}. Your reply should:
- Be genuinely useful and contextual to what they said
- Be in the founder's voice (above)
- Length: ${lengthHint}
- Naturally mention ${input.product} ONLY if it actually solves their problem
- Never sound like marketing copy or a sales pitch
- Never use cringe phrases ("Game-changer!", "Disrupting", etc.)

Output ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "body": "<the reply text, no quotes, no @ mention prefix>",
  "whyItWorks": "<1-sentence rationale>",
  "confidence": 0.0
}
\`\`\``,
    messages: [
      {
        role: "user",
        content: `Thread from ${input.thread.author ?? "someone"}:\n\n${input.thread.content}`,
      },
    ],
  });

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) {
    return { body: text.slice(0, 280), whyItWorks: "fallback parse", confidence: 0 };
  }

  try {
    const parsed = JSON.parse(candidate) as {
      body?: string;
      whyItWorks?: string;
      confidence?: number;
    };
    return {
      body: typeof parsed.body === "string" ? parsed.body : "",
      whyItWorks:
        typeof parsed.whyItWorks === "string" ? parsed.whyItWorks : "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch {
    return { body: text.slice(0, 280), whyItWorks: "JSON parse failed", confidence: 0 };
  }
}
