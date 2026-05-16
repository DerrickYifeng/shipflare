/**
 * `/api/cmo-ws-token` — session-aware activity-scoped JWT issuer.
 *
 * The browser fetches this immediately before opening a WebSocket to
 * apps/core's `/agents/cmo/<userId>` endpoint (the activity feed). Mirrors
 * `/api/mcp-token` but adds `scope: 'activity'` to the claims so a leaked
 * activity token cannot be replayed against the `/mcp` path — CMO.onConnect
 * enforces the scope check before accepting the WS.
 *
 * Token TTL: 60s. The token is only used to authenticate the WS upgrade
 * handshake; CMO does not re-verify per frame. Reconnect = new token via
 * this route.
 *
 * Browsers can't set custom headers on `new WebSocket()`, so the token
 * is delivered via the `?token=` query string. The 60s TTL bounds leak
 * exposure (proxies / referer logs); the `scope: 'activity'` claim
 * confines the blast radius to the activity feed even if it does leak.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signJwt } from "@/lib/jwt";

// Force dynamic so each call sees the current session cookie + signs a
// fresh token. Without this Next.js may attempt to statically prerender
// the route and the session lookup would short-circuit.
export const dynamic = "force-dynamic";

interface CmoWsTokenResponseBody {
  token: string;
  wsUrl: string;
}

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  const { env } = getCloudflareContext();
  const token = await signJwt(
    { userId: session.user.id, scope: "activity" },
    env.MCP_JWT_SECRET,
    // 60s is enough to open the WebSocket; activity events thereafter
    // flow over the established WS with no re-verification per frame.
    60,
  );

  // Fallback origin is dev-only (apps/core's default `wrangler dev` port).
  // Production / staging must set CORE_PUBLIC_URL via `wrangler secret put`.
  const corePublicUrl = env.CORE_PUBLIC_URL ?? "http://localhost:3001";
  // The WebSocket URL uses ws(s):// — derive it from the core HTTP origin
  // so we don't hardcode a second URL pattern in the client bundle.
  const wsOrigin = corePublicUrl.replace(/^http/, "ws");

  const body: CmoWsTokenResponseBody = {
    token,
    wsUrl: `${wsOrigin}/agents/cmo/${session.user.id}`,
  };
  return Response.json(body);
}
