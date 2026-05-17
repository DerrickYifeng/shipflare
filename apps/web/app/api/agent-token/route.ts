/**
 * /api/agent-token — generic session-aware JWT issuer for any AIChatAgent.
 *
 * The browser fetches this immediately before opening a WebSocket to
 * apps/core's `/agents/<agent>/<name>` chat endpoint (the AIChatAgent
 * transport).
 *
 * Phase 8 replacement for the per-agent `/api/cmo-ws-token` route —
 * which exclusively served the legacy `scope: 'activity'` WS used by
 * the activity-trail UI. The new chat surface uses AIChatAgent's
 * native WS transport, so the token's claims are scoped to the agent
 * + DO name rather than to an "activity" feed.
 *
 * Allowed agents: cmo, hog, smm (the EMPLOYEE_REGISTRY ids). Returns
 * 400 if the param is missing or not one of these.
 *
 * Token TTL: 60s. Brief enough that a leak via URL is bounded; long
 * enough to open the WS reliably.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signJwt } from "@/lib/jwt";

// Force dynamic so each call sees the current session cookie + signs a
// fresh token. Without this Next.js may attempt to statically prerender
// the route and the session lookup would short-circuit.
export const dynamic = "force-dynamic";

// Mirror EMPLOYEE_REGISTRY (apps/core/src/agents/registry.ts). Adding a
// new employee requires updating both registries; see CLAUDE.md New
// Employee Checklist.
const ALLOWED_AGENTS = new Set(["cmo", "hog", "smm"] as const);

export async function GET(req: Request): Promise<Response> {
  // Resolve env before any await — see /api/mcp-token/route.ts comment for
  // the v1.19.x reason (`{async:true}` avoids sync overload's post-await throw).
  const { env } = await getCloudflareContext({ async: true });

  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const agent = url.searchParams.get("agent");
  const name = url.searchParams.get("name") ?? session.user.id;
  if (!agent || !ALLOWED_AGENTS.has(agent as "cmo" | "hog" | "smm")) {
    return new Response("missing or invalid agent param", { status: 400 });
  }

  const token = await signJwt(
    { userId: session.user.id, agent, name },
    env.MCP_JWT_SECRET,
    // 60s is enough to open the WebSocket; chat events thereafter
    // flow over the established WS with no re-verification per frame.
    60,
  );

  return Response.json({ token });
}
