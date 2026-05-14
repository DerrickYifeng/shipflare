import { z } from "zod";
import type { HackerNewsMcpAgent } from "../HackerNewsMcpAgent";

/**
 * hn_search — search Hacker News stories + comments via Algolia.
 *
 * Algolia hosts HN's public search API at `hn.algolia.com/api/v1` —
 * anonymous, no auth needed, 10k req/h shared bucket. The relevant
 * endpoints:
 *
 *   /search          — sort by relevance (default)
 *   /search_by_date  — sort by recency
 *
 * We use `/search` so the LLM-driven caller (SMM) sees the strongest
 * matches first. Phase 2 follow-up can expose a `sort` knob if founders
 * want date-sorted results for monitoring fresh launches.
 *
 * The hit shape varies by `_tags`:
 *   - story:    has `title`, `url`, maybe `story_text`
 *   - comment:  has `comment_text`, `story_title`, `parent_id`
 *   - poll:     has `title`, `points`
 *
 * We normalize all three into `{ externalId, author, content }` to
 * match the X/Reddit thread shape SMM's discovery loop already
 * consumes — no per-platform branching in the caller.
 *
 * Graceful degradation: any network / parse failure returns an empty
 * array rather than throwing. HN is one source among many for the
 * caller; better to skip a tick than crash the sweep.
 */
export function registerHackerNewsSearchTool(
  agent: HackerNewsMcpAgent,
): void {
  agent.server.registerTool(
    "hn_search",
    {
      description:
        "Search Hacker News stories and comments via Algolia (anonymous; " +
        "no auth required). Returns normalized `{ externalId, author, content }`.",
      inputSchema: {
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query, maxResults }) => {
      void agent;
      const url =
        `https://hn.algolia.com/api/v1/search` +
        `?query=${encodeURIComponent(query)}` +
        `&hitsPerPage=${maxResults}`;

      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        console.error("[hn_search] fetch failed:", err);
        return emptyArrayContent();
      }

      if (!res.ok) {
        console.error(
          `[hn_search] Algolia returned ${res.status}: ${await res
            .text()
            .catch(() => "(no body)")}`,
        );
        return emptyArrayContent();
      }

      let data: AlgoliaSearchResponse;
      try {
        data = (await res.json()) as AlgoliaSearchResponse;
      } catch (err) {
        console.error("[hn_search] response JSON parse failed:", err);
        return emptyArrayContent();
      }

      const hits = Array.isArray(data.hits) ? data.hits : [];
      const threads = hits.map((h) => ({
        externalId: String(h.objectID ?? ""),
        author: typeof h.author === "string" ? h.author : undefined,
        content:
          h.title ??
          h.story_text ??
          h.comment_text ??
          h.story_title ??
          "",
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(threads) },
        ],
      };
    },
  );
}

interface AlgoliaHit {
  objectID?: string;
  author?: string;
  title?: string;
  url?: string;
  story_text?: string;
  comment_text?: string;
  story_title?: string;
  _tags?: string[];
}

interface AlgoliaSearchResponse {
  hits?: AlgoliaHit[];
}

function emptyArrayContent(): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: "[]" }],
  };
}
