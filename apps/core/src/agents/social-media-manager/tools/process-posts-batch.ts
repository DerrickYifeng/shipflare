import { z } from "zod";
import { runSkill } from "@shipflare/skills";
import { mcpServerName } from "@shipflare/shared";
import { validateDraft } from "../lib/validators";
import { extractText } from "../lib/mcp-result";
import type { SocialMediaMgr } from "../SocialMediaMgr";

interface PlanItemRow {
  id: string;
  skill: string;
  channel: string;
  params_json: string;
  status: string;
  owner_role: string;
  scheduled_for: number | null;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * process_posts_batch — draft original posts for a batch of plan_item ids.
 *
 * Called by CMO via delegateToEmployee. The CMO sources plan_items (HoG
 * generates them via plan tools); SMM executes by drafting + persisting.
 *
 * Per plan item:
 *   1. Read item via CMO.queryPlanItems (filtered by id list)
 *   2. Pull founder_context for voice + product knowledge
 *   3. runSkill("drafting-post") to draft an original post
 *   4. Validate via validateDraft (platform-leak + length)
 *   5. Persist to drafts (kind='post', plan_item_id link, status='ready'/'failed')
 *   6. RPC CMO.updatePlanItem(id, status='in_progress', output={ draftId }) if valid
 *
 * Per spec §6.1: SMM never writes CMO's plan_items directly. updates go via
 * the exposed RPC tool.
 *
 * S6.1: the drafting prompt has been lifted to packages/skills/drafting-post
 * and is invoked via `runSkill`. The inline `draftPost` helper is gone.
 *
 * Bulk-fetch design: we pull the full pending pool (capped at 200) in one
 * round-trip and filter in-memory by the requested ids. Cheaper than N
 * queryPlanItems calls and aligns with the batched-LLM cost shape of
 * `find_threads_via_xai`.
 */
export function registerProcessPostsBatchTool(agent: SocialMediaMgr): void {
  agent.server.registerTool(
    "process_posts_batch",
    {
      description:
        "Draft original posts for a batch of plan_item ids. Reads each item, " +
        "drafts via LLM in the founder's voice, validates, persists to drafts " +
        "table. Updates each plan_item to in_progress via CMO RPC.",
      inputSchema: {
        conversationId: z.string().min(1),
        planItemIds: z.array(z.string().min(1)).min(1).max(20),
        voiceOverride: z
          .string()
          .optional()
          .describe(
            "Override founder_context.voice with a one-off instruction. " +
              "Use sparingly; default voice should win in production.",
          ),
      },
    },
    async ({ conversationId, planItemIds, voiceOverride }) => {
      const userId = agent.props?.userId;
      if (!userId) throw new Error("SMM has no userId; cannot draft posts");

      const cmoServerName = mcpServerName("cmo", userId);
      const cmo = agent.mcp.listServers().find((s) => s.name === cmoServerName);
      if (!cmo) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                itemsScanned: 0,
                draftsCreated: 0,
                draftsSkipped: planItemIds.length,
                notes: [
                  "CMO not connected — cannot fetch plan_items or update status",
                ],
              }),
            },
          ],
        };
      }

      // Step 1: pull plan_items via CMO RPC. Single round-trip; filter to
      // requested ids in-memory.
      let allItems: PlanItemRow[] = [];
      try {
        const result = await agent.mcp.callTool({
          serverId: cmo.id,
          name: "queryPlanItems",
          arguments: { status: "pending", limit: 200 },
        });
        allItems = JSON.parse(extractText(result)) as PlanItemRow[];
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                itemsScanned: 0,
                draftsCreated: 0,
                draftsSkipped: planItemIds.length,
                notes: [`queryPlanItems failed: ${String(err)}`],
              }),
            },
          ],
        };
      }
      const itemMap = new Map(allItems.map((i) => [i.id, i]));

      // Step 2: pull founder_context
      let founderContext: Record<string, string> = {};
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
      const product = founderContext.productName ?? "(product not set)";
      const productDescription = founderContext.productDescription ?? "";
      const voice =
        voiceOverride ??
        founderContext.voice ??
        "casual, direct, no marketing fluff";

      // Step 3: process each requested id
      let draftsCreated = 0;
      let draftsSkipped = 0;
      const notes: string[] = [];

      for (const planItemId of planItemIds) {
        const item = itemMap.get(planItemId);
        if (!item) {
          draftsSkipped++;
          notes.push(`${planItemId}: not in pending plan_items pool`);
          continue;
        }

        const platform = item.channel as "x" | "reddit";
        const lengthHint = platform === "x" ? "≤ 280 chars" : "≤ 1500 chars";
        const params = JSON.parse(item.params_json) as Record<string, unknown>;

        // Step 3a: draft via `drafting-post` skill
        let draftBody = "";
        let whyItWorks = "";
        let confidence = 0;
        try {
          const raw = await runSkill<unknown>(
            "drafting-post",
            {
              platform,
              product,
              productDescription: productDescription || "no description",
              voice,
              lengthHint,
              skill: item.skill,
              params: JSON.stringify(params, null, 2),
            },
            { env: { ANTHROPIC_API_KEY: agent.bindings.ANTHROPIC_API_KEY } },
          );
          if (raw && typeof raw === "object") {
            const parsed = raw as {
              body?: unknown;
              whyItWorks?: unknown;
              confidence?: unknown;
            };
            draftBody = typeof parsed.body === "string" ? parsed.body : "";
            whyItWorks =
              typeof parsed.whyItWorks === "string" ? parsed.whyItWorks : "";
            confidence =
              typeof parsed.confidence === "number" ? parsed.confidence : 0;
          } else if (typeof raw === "string") {
            draftBody = raw.slice(0, 280);
            whyItWorks = "fallback parse";
            confidence = 0;
          }
        } catch (err) {
          draftsSkipped++;
          notes.push(`${planItemId}: LLM failed: ${String(err)}`);
          continue;
        }

        // Step 3b: validate
        const validation = validateDraft(draftBody, platform);
        const draftId = crypto.randomUUID();
        const now = Date.now();
        const status = validation.ok ? "ready" : "failed";

        // Step 3c: persist draft
        agent.sqlStorage.exec(
          `INSERT INTO drafts
             (conversation_id, id, kind, plan_item_id, platform, thread_id, body,
              why_it_works, confidence, status, audit_notes_json, created_at, updated_at)
           VALUES (?, ?, 'post', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          conversationId,
          draftId,
          planItemId,
          platform,
          draftBody,
          whyItWorks || null,
          confidence,
          status,
          JSON.stringify({ validation, planItemId }),
          now,
          now,
        );

        if (!validation.ok) {
          draftsSkipped++;
          notes.push(
            `${planItemId}: validation failed: ${validation.reasons.join("; ")}`,
          );
          continue;
        }

        // Step 3d: update plan_item to in_progress via CMO RPC.
        // Draft is canonical; CMO out-of-sync is recoverable (CMO can
        // re-query SMM.list_drafts to reconcile). Non-fatal on failure.
        try {
          await agent.mcp.callTool({
            serverId: cmo.id,
            name: "updatePlanItem",
            arguments: {
              id: planItemId,
              status: "in_progress",
              output: { draftId },
            },
          });
        } catch (err) {
          console.warn(
            `[SMM ${userId}] updatePlanItem failed for ${planItemId}:`,
            err,
          );
          notes.push(
            `${planItemId}: draft created but plan_item update failed`,
          );
        }

        draftsCreated++;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              itemsScanned: planItemIds.length,
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
