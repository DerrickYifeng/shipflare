import { z } from "zod";
import type { SocialMediaMgr } from "../SocialMediaMgr";

/**
 * find_threads — read threads_inbox without re-running discovery.
 *
 * Companion to find_threads_via_xai: that one fetches + judges + persists;
 * this one just reads the cache. Use this when the founder asks "what
 * threads do we have queued?" or when plan-execute needs to find work.
 *
 * Per spec §6.1 invariant #1: this reads SMM's OWN SQLite only — never
 * CMO's. The judging pipeline (find_threads_via_xai) is the only writer
 * to threads_inbox; this tool is read-only.
 *
 * Filter shape: dynamic IN-clause on platform (CSV of placeholders) plus a
 * caller-controlled LIMIT. ORDER prefers freshest judged_at, NULLs (un-
 * judged rows, defensive — shouldn't exist in steady state) bubble to the
 * bottom via the `IS NULL` trick because workerd's SQLite predates
 * standard `NULLS LAST` syntax in some builds; using the portable form is
 * cheaper than asserting build version.
 */
export function registerFindThreadsTool(agent: SocialMediaMgr): void {
  agent.server.registerTool(
    "find_threads",
    {
      description:
        "Read threads_inbox without triggering new discovery. Filter by " +
        "platform and limit.",
      inputSchema: {
        platforms: z
          .array(z.enum(["x", "reddit"]))
          .min(1)
          .default(["x"])
          .describe("Which platforms to read from (defaults to ['x'])"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ platforms, limit }) => {
      // Dynamic IN-clause: SqlStorage.exec is varargs so we expand
      // placeholders to match `platforms.length` and spread the values
      // through. Caller-provided values flow through bind parameters, not
      // string interpolation — no injection surface.
      const placeholders = platforms.map(() => "?").join(",");
      const rows = agent.sqlStorage
        .exec<{
          id: string;
          platform: string;
          external_id: string;
          author: string | null;
          content: string;
          score: number | null;
          judged_at: number | null;
          expires_at: number | null;
        }>(
          `SELECT id, platform, external_id, author, content, score, judged_at, expires_at
           FROM threads_inbox
           WHERE platform IN (${placeholders})
           ORDER BY judged_at IS NULL, judged_at DESC
           LIMIT ?`,
          ...platforms,
          limit,
        )
        .toArray();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
