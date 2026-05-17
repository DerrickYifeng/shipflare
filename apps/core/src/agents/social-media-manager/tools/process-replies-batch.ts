import { z } from "zod";
import { runSkill } from "@shipflare/skills";
import { mcpServerName } from "@shipflare/shared";
import { validateDraft } from "../lib/validators";
import { extractText } from "../lib/mcp-result";
import type { SocialMediaMgr } from "../SocialMediaMgr";
import {
  extractTrace,
  withSubAgentToolTracing,
} from "../../../lib/subagent-activity";

/**
 * process_replies_batch — draft replies for a batch of thread ids.
 *
 * Called by CMO via delegateToEmployee after find_threads_via_xai surfaces
 * candidates worth replying to.
 *
 * Per thread:
 *   1. Read from threads_inbox
 *   2. Pull founder_context (voice + product) from CMO RPC
 *   3. runSkill("drafting-reply") to draft a reply in the founder's voice
 *   4. Validate: platform-leak + length limits (S6 ports throttle too)
 *   5. Persist to drafts table (status='ready' if valid; 'failed' if not)
 *
 * S6.1: the drafting prompt has been lifted to packages/skills/drafting-reply
 * and is invoked via `runSkill`. The inline `draftReply` helper is gone.
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
        _trace: z.unknown().optional(),
      },
    },
    async (args) => {
      const trace = extractTrace(args);
      const { conversationId, threadIds, voiceOverride } = args as {
        conversationId: string;
        threadIds: string[];
        voiceOverride?: string;
      };
      return withSubAgentToolTracing(
        agent.runtimeCtx,
        agent.bindings,
        trace,
        "social-media-manager",
        "process_replies_batch",
        args,
        async () => {
          const userId = agent.props?.userId;
          if (!userId)
            throw new Error("SMM has no userId; cannot draft replies");

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
            const lengthHint =
              platform === "x" ? "≤ 280 chars" : "≤ 1000 chars";

            // Step 3: draft the reply via the `drafting-reply` skill
            let draftBody = "";
            let whyItWorks = "";
            let confidence = 0;
            try {
              const raw = await runSkill<unknown>({
                name: "drafting-reply",
                args: {
                  product,
                  productDescription: productDescription || "no description",
                  voice,
                  platform,
                  lengthHint,
                  threadAuthor: threadRow.author ?? "someone",
                  threadContent: threadRow.content,
                },
                env: { ANTHROPIC_API_KEY: agent.bindings.ANTHROPIC_API_KEY },
              });
              if (raw && typeof raw === "object") {
                const parsed = raw as {
                  body?: unknown;
                  whyItWorks?: unknown;
                  confidence?: unknown;
                };
                draftBody = typeof parsed.body === "string" ? parsed.body : "";
                whyItWorks =
                  typeof parsed.whyItWorks === "string"
                    ? parsed.whyItWorks
                    : "";
                confidence =
                  typeof parsed.confidence === "number" ? parsed.confidence : 0;
              } else if (typeof raw === "string") {
                // Fallback: runner couldn't parse JSON, returned raw text.
                draftBody = raw.slice(0, 280);
                whyItWorks = "fallback parse";
                confidence = 0;
              }
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
              // TODO(P2-F.2): notify founder via web push when a reply draft hits
              // 'ready' status. Wire this through the CMO DO's sendPushToFounder()
              // helper — needs a peer RPC channel from SMM → CMO (the
              // peer-dm-shadow + employee_log path is the natural seam; a tiny
              // "draft_ready" message type on /internal/peer-dm-shadow can carry
              // the platform + threadId + draftId so the CMO can fire the push +
              // record it in employee_log atomically).
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
    },
  );
}
