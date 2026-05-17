/**
 * Static catalog of every employee role ShipFlare has ever shipped or might ship.
 *
 * Per Phase 0 spike #2 finding: when `addMcpServer(name, ns, ...)` is called in a
 * parent agent's onStart(), the McpServer DO instance identity is derived from
 * `name`. If two users' CMOs both call addMcpServer("smm", ...), they SHARE one
 * DO — breaking per-tenant isolation. Always namespace: addMcpServer(
 * `${role}-${userId}`, env[binding], { props: { userId, caller: "cmo" } }).
 */

export interface RoleEntry {
  /** Wrangler binding name; MUST match the wrangler.jsonc durable_objects.bindings[].name */
  binding:
    | "CMO"
    | "HOG"
    | "SMM"
    | "COPYWRITER"
    | "BRAND_ANALYST"
    | "COMMUNITY_MGR";
  /** Founder-facing display name */
  displayName: string;
  /** Tier — Phase 1 ships only "core" tier roles */
  tier: "core" | "pro";
  /** Whether this role is hired by default on new accounts */
  defaultActive: boolean;
}

export const ROLE_REGISTRY = {
  "cmo": {
    binding: "CMO",
    displayName: "CMO",
    tier: "core",
    defaultActive: true,
  },
  "head-of-growth": {
    binding: "HOG",
    displayName: "Head of Growth",
    tier: "core",
    defaultActive: true,
  },
  "social-media-manager": {
    binding: "SMM",
    displayName: "Social Media Manager",
    tier: "core",
    defaultActive: true,
  },
  // Phase 2 expanded roster — Pro tier, opt-in hires (defaultActive: false).
  // Each ships as its own McpAgent DO class with private SQLite (v5/v6/v7
  // migrations). Founders explicitly "hire" them through the roster UI; the
  // CMO never auto-spawns them.
  "copywriter": {
    binding: "COPYWRITER",
    displayName: "Copywriter",
    tier: "pro",
    defaultActive: false,
  },
  "brand-analyst": {
    binding: "BRAND_ANALYST",
    displayName: "Brand Analyst",
    tier: "pro",
    defaultActive: false,
  },
  "community-manager": {
    binding: "COMMUNITY_MGR",
    displayName: "Community Manager",
    tier: "pro",
    defaultActive: false,
  },
} as const satisfies Record<string, RoleEntry>;

export type RoleSlug = keyof typeof ROLE_REGISTRY;

export function isValidRole(slug: string): slug is RoleSlug {
  return slug in ROLE_REGISTRY;
}

/**
 * Build the per-tenant namespaced server name for `addMcpServer`.
 *
 * Per Phase 0 spike #2: every addMcpServer call MUST use a name unique to the
 * caller tenant, otherwise the McpServer DO is shared globally.
 */
export function mcpServerName(role: RoleSlug, userId: string): string {
  return `${role}-${userId}`;
}
