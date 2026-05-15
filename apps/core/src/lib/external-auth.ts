/**
 * External MCP exposure — OAuth-style scope enum + JWT shape + verifier.
 *
 * Phase 2 (P2-A) opens up ShipFlare's per-employee MCP servers to 3rd-party
 * MCP clients (Claude Desktop, Cursor, the founder's own LLM stack). Phase 1
 * tokens (`MCP_JWT_SECRET`) are short-lived (60s) and serve only the founder
 * UI; Phase 2 tokens (`EXTERNAL_MCP_SECRET`) are long-lived (30d) and signed
 * with a separate secret so a leaked browser-session token can't be used to
 * impersonate a 3rd-party client (and vice-versa).
 *
 * Route shape:
 *   /agents/<role>/<userId>/mcp             — internal (Phase 1, founder UI)
 *   /external/agents/<role>/<userId>/mcp    — external (Phase 2, third party)
 *
 * Scope semantics (P2-A — URL-level, forward-compat for per-tool gating):
 *   A valid token for `{ userId, role }` currently grants access to ALL tools
 *   on that role. The scope array is RECORDED in the token but NOT enforced
 *   per-tool yet — per-tool gating requires plumbing the request headers
 *   into individual McpAgent tool handlers, which is a P2-A-followup. The
 *   four-value scope enum below + TOOL_SCOPE_MAP are forward-compat so we
 *   can flip enforcement on without re-issuing tokens.
 */

import { verifyJwt } from "./jwt";

export type ExternalScope =
  | "read" // chat, queryRoster, queryPlanItems, listConversations, queryDrafts
  | "draft" // process_replies_batch, process_posts_batch (drafts only, no publish)
  | "publish" // x_post, reddit_post, approveDraft (full publish)
  | "admin"; // hireEmployee, fireEmployee, commitStrategicPath, setFounderContext

/**
 * Shape of the JWT body for an external MCP token. `iat` / `exp` are added
 * by `signJwt`; callers pass `{ userId, role, scope }`.
 */
export interface ExternalToken {
  /** D1 `user.id` this token is scoped to. */
  userId: string;
  /**
   * Employee role this token grants access to. `"*"` means any role
   * (admin escape hatch; not exposed via the UI). Otherwise must match
   * the URL's `<role>` segment exactly.
   */
  role: string;
  /** Scopes recorded at issue time. Forward-compat for per-tool gating. */
  scope: ExternalScope[];
  iat: number;
  exp: number;
}

/**
 * Verify an external MCP token against the URL it's being used for.
 *
 * Returns `null` on:
 *   - Missing / malformed `Authorization` header
 *   - Invalid signature or expired token
 *   - `token.userId` !== URL `userId`
 *   - `token.role` !== URL `role` (and not `"*"`)
 *   - Empty / missing scope array
 *
 * Callers (the Worker entry) return 401 on null.
 */
export async function validateExternalAccess(
  req: Request,
  env: { EXTERNAL_MCP_SECRET: string },
  urlUserId: string,
  urlRole: string,
): Promise<ExternalToken | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const claims = await verifyJwt(auth.slice(7), env.EXTERNAL_MCP_SECRET);
    // `verifyJwt` already enforces `exp` and signature. We trust the shape
    // here because we sign and verify with the same secret — any malformed
    // payload would either fail the signature check or fail this validation.
    const token = claims as unknown as ExternalToken;

    if (typeof token.userId !== "string" || token.userId !== urlUserId) {
      return null;
    }
    if (typeof token.role !== "string") return null;
    if (token.role !== urlRole && token.role !== "*") return null;
    if (!Array.isArray(token.scope) || token.scope.length === 0) return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * Forward-compat: does this token hold the named scope?
 *
 * Phase 2 P2-A does NOT enforce this per tool — see file header. Wire this
 * in once per-tool gating is implemented in P2-A.followup.
 */
export function hasScope(
  token: ExternalToken,
  required: ExternalScope,
): boolean {
  return token.scope.includes(required);
}

/**
 * Tool name → required scope. Tools not in this map default to `read`.
 *
 * KEEP IN SYNC with the tool registrations in agents/*\/tools/*.ts. When you
 * add a new tool that mutates state, add it here with at least `draft`
 * (or `publish` / `admin` per its blast radius).
 */
export const TOOL_SCOPE_MAP: Record<string, ExternalScope> = {
  // CMO
  chat: "read",
  startNewConversation: "read",
  listConversations: "read",
  queryRoster: "read",
  queryPlanItems: "read",
  queryDrafts: "read",
  queryFounderContext: "read",
  hireEmployee: "admin",
  fireEmployee: "admin",
  approveDraft: "publish",
  setFounderContext: "admin",
  commitStrategicPath: "admin",
  addPlanItem: "draft",
  updatePlanItem: "draft",
  delegateToEmployee: "draft",
  // P2-D — cross-conversation memory (opt-in "Remember this"). rememberThis /
  // forgetThis mutate the long-term memory store and ride in every future
  // system prompt, so they're admin-scope. queryMemory is read-only.
  rememberThis: "admin",
  forgetThis: "admin",
  queryMemory: "read",
  // Head of Growth
  generate_strategic_path: "draft",
  audit_plan: "read",
  // Social Media Manager
  find_threads_via_xai: "draft",
  findThreadsViaXai: "draft",
  find_threads: "read",
  process_replies_batch: "draft",
  process_posts_batch: "draft",
  list_drafts: "read",
  research_reddit_channels: "draft",
  // Platform tool MCPs (not exposed at /external yet but registered here so
  // the map stays the single source of truth).
  x_search: "read",
  x_post: "publish",
  x_metrics: "read",
  reddit_search: "read",
  reddit_post: "publish",
  research_subreddits: "draft",
};

/**
 * Default to `read` for unknown tools — safest fallback. Once a tool is
 * added to TOOL_SCOPE_MAP it overrides this default.
 */
export function getRequiredScope(toolName: string): ExternalScope {
  return TOOL_SCOPE_MAP[toolName] ?? "read";
}
