import { z } from "zod";
import type { LinkedInMcpAgent } from "../LinkedInMcpAgent";

/**
 * linkedin_search — discover LinkedIn posts for the founder's brand.
 *
 * STUB. LinkedIn's content-search API (`/v2/socialActions/{share}/comments`
 * and the Posts Search beta) requires LinkedIn Marketing Developer
 * Platform (LMDP) access — a paid B2B tier most founders don't have.
 * Without LMDP we can't programmatically search LinkedIn posts.
 *
 * Phase 2 P2-E ships this as a documented stub: return an empty array
 * with a `note` field so SMM's `find_threads_via_xai` (which fans out
 * across platforms) handles the empty result the same way it handles
 * "no threads found" elsewhere — no special-casing needed.
 *
 * Phase 2 P2-E.2 follow-up: once LMDP access is approved, swap this for
 * a real call to `/v2/socialActions` with the founder's OAuth token.
 * Until then, founders who want LinkedIn coverage can drive the post
 * tool directly via the external MCP route.
 */
export function registerLinkedInSearchTool(agent: LinkedInMcpAgent): void {
  agent.server.registerTool(
    "linkedin_search",
    {
      description:
        "Search LinkedIn posts (STUB — requires LinkedIn Marketing " +
        "Developer Platform access; returns empty array with note).",
      inputSchema: {
        product: z.string().min(1),
        productDescription: z.string().optional(),
        intent: z.string().optional(),
        maxResults: z.number().int().min(1).max(50).default(20),
      },
    },
    async () => {
      // Mark `agent` as used to satisfy strict TS; the parameter is kept
      // in the signature so future implementations can read `bindings`
      // for the OAuth token and `sqlStorage` for the cache without
      // touching the registration shape.
      void agent;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              threads: [],
              note:
                "LinkedIn search is not yet implemented — requires " +
                "LinkedIn Marketing Developer Platform access. " +
                "Founders can still publish via linkedin_post.",
            }),
          },
        ],
      };
    },
  );
}
