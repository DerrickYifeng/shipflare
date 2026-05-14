/**
 * `/api/mcp-token` — session-aware short-lived JWT issuer.
 *
 * The browser fetches this immediately before opening an MCP connection to
 * apps/core's `/agents/<role>/<userId>/mcp` endpoint. Per spec D13, the web
 * Worker is NOT a proxy for chat traffic — its only job here is to verify
 * the Better Auth session cookie and hand the browser a token that proves
 * "this user is authorised to talk to /agents/cmo/<their userId>/mcp".
 *
 * Token TTL is intentionally short (60s). It's only used to bootstrap the
 * MCP handshake — once the SSE stream is established core does not re-
 * verify per request. Reconnect = new token via this route.
 *
 * The `mcpUrl` field is the absolute URL the browser should connect to.
 * Built from `env.CORE_PUBLIC_URL` (set per environment) so we don't have
 * to hardcode origins in the client bundle.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signJwt } from "@/lib/jwt";

// Force dynamic so each call sees the current session cookie + signs a fresh
// token. Without this Next.js may attempt to statically prerender the route
// and the session lookup would short-circuit.
export const dynamic = "force-dynamic";

interface McpTokenResponseBody {
  token: string;
  mcpUrl: string;
}

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  const { env } = getCloudflareContext();
  const token = await signJwt(
    { userId: session.user.id },
    env.MCP_JWT_SECRET,
    // 60s is enough to complete the MCP handshake; the resulting stream
    // continues without re-verification per spec.
    60,
  );

  // Fallback origin is dev-only (apps/core's default `wrangler dev` port).
  // Production / staging must set CORE_PUBLIC_URL via `wrangler secret put`.
  const corePublicUrl = env.CORE_PUBLIC_URL ?? "http://localhost:3001";

  const body: McpTokenResponseBody = {
    token,
    mcpUrl: `${corePublicUrl}/agents/cmo/${session.user.id}/mcp`,
  };
  return Response.json(body);
}
