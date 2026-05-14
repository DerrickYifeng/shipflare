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
  binding: "CMO" | "HEAD_OF_GROWTH" | "SOCIAL_MEDIA_MGR";
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
    binding: "HEAD_OF_GROWTH",
    displayName: "Head of Growth",
    tier: "core",
    defaultActive: true,
  },
  "social-media-manager": {
    binding: "SOCIAL_MEDIA_MGR",
    displayName: "Social Media Manager",
    tier: "core",
    defaultActive: true,
  },
  // Phase 2 additions go here (Copywriter, Brand Analyst, Community Manager, etc.)
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
