/**
 * Static catalog of every platform tool MCP ShipFlare ships.
 *
 * Platforms differ from EMPLOYEES (which live in `role-registry.ts`):
 *   - Roles  = autonomous LLM-driven employees (CMO, HoG, SMM, ...). They run
 *              tools, judge outputs, decompose goals.
 *   - Platforms = leaf tool surfaces (X, Reddit, future LinkedIn / Threads).
 *              Their MCP DOs hold cached rate-limit state + posted history;
 *              they expose tools like `x_search` / `reddit_post` but never
 *              spawn sub-agents or carry a strategic-path opinion.
 *
 * Per Phase 0 spike #2 finding: every `addMcpServer(name, ns, ...)` call MUST
 * use a name unique to the caller tenant, otherwise the McpServer DO is shared
 * across users. `platformServerName(platform, userId)` returns the canonical
 * `${platform}-mcp-${userId}` form used by `SocialMediaMgr.connectToPeers()`.
 *
 * Replaces SMM's previous `mcpServerName("x-mcp" as any, userId)` cast (S4).
 * The cast leaked because `RoleSlug` only enumerates EMPLOYEE roles —
 * platforms need their own slug type, which is what this module provides.
 */

export interface PlatformEntry {
  /** Wrangler binding name; MUST match wrangler.jsonc durable_objects.bindings[].name */
  binding:
    | "X_MCP"
    | "REDDIT_MCP"
    | "LINKEDIN_MCP"
    | "HN_MCP"
    | "DISCORD_MCP";
  /** Founder-facing display name */
  displayName: string;
  /** Phase the binding ships in — kept for forward-compat / observability */
  shipsInPhase: "phase-1-s5" | "phase-2";
}

export const PLATFORMS = {
  "x": {
    binding: "X_MCP",
    displayName: "X",
    shipsInPhase: "phase-1-s5",
  },
  "reddit": {
    binding: "REDDIT_MCP",
    displayName: "Reddit",
    shipsInPhase: "phase-1-s5",
  },
  // P2-E — Phase 2 additions. Each carries:
  //   1. An entry in this map
  //   2. A wrangler.jsonc binding + migration tag (v8 covers all three)
  //   3. A McpAgent subclass under `apps/core/src/agents/platforms/<slug>/`
  //   4. (LinkedIn / Discord only) An OAuth-or-form connect+callback in
  //      `apps/web/app/api/channels/<slug>/`
  //   5. The slug added to `channels.platform` enum in
  //      `packages/db/src/schema.ts` + the matching CHECK in migration
  //      002_extend_platforms.sql.
  // HN is anonymous (read-only via Algolia) — no channels row, no OAuth.
  "linkedin": {
    binding: "LINKEDIN_MCP",
    displayName: "LinkedIn",
    shipsInPhase: "phase-2",
  },
  "hackernews": {
    binding: "HN_MCP",
    displayName: "Hacker News",
    shipsInPhase: "phase-2",
  },
  "discord": {
    binding: "DISCORD_MCP",
    displayName: "Discord",
    shipsInPhase: "phase-2",
  },
} as const satisfies Record<string, PlatformEntry>;

export type PlatformSlug = keyof typeof PLATFORMS;

export function isValidPlatform(slug: string): slug is PlatformSlug {
  return slug in PLATFORMS;
}

/**
 * Build the per-tenant namespaced server name for `addMcpServer` when dialing
 * a platform tool MCP from an employee DO.
 *
 * Format: `${platform}-mcp-${userId}` (e.g. `x-mcp-user-abc`).
 *
 * The `-mcp-` infix distinguishes platform tool DOs from employee DOs
 * (`cmo-user-abc`, `social-media-manager-user-abc`), so listServers() output
 * is unambiguous when an SMM dials both CMO and X_MCP.
 */
export function platformServerName(
  platform: PlatformSlug,
  userId: string,
): string {
  return `${platform}-mcp-${userId}`;
}
