import { z } from "zod";
import type { SocialMediaMgr } from "../SocialMediaMgr";

/**
 * list_drafts — list drafts by status.
 *
 * CMO's `queryDrafts` tool RPCs to this. Founder UI uses CMO.queryDrafts
 * to fetch what's awaiting approval; the actual data lives here in SMM's
 * SQLite (per spec §4.2.5 + §6.1 — drafts are SMM's private working
 * state).
 *
 * Defaults to status='ready' (drafts awaiting founder approval) since
 * that's the primary UI use case. Most-recently-updated first so the
 * `/today` UI shows freshest work without an extra timestamp comparator.
 */
export function registerListDraftsTool(agent: SocialMediaMgr): void {
  agent.server.registerTool(
    "list_drafts",
    {
      description:
        "List drafts by status. Default: status='ready' (awaiting approval). " +
        "Returns most-recently-updated first.",
      inputSchema: {
        status: z
          .enum(["drafting", "ready", "posted", "failed", "rejected"])
          .default("ready"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ status, limit }) => {
      const rows = agent.sqlStorage
        .exec<{
          id: string;
          conversation_id: string | null;
          kind: string;
          plan_item_id: string | null;
          platform: string;
          thread_id: string | null;
          body: string;
          why_it_works: string | null;
          confidence: number | null;
          status: string;
          created_at: number;
          updated_at: number;
        }>(
          `SELECT id, conversation_id, kind, plan_item_id, platform, thread_id,
                  body, why_it_works, confidence, status, created_at, updated_at
           FROM drafts
           WHERE status = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          status,
          limit,
        )
        .toArray();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
