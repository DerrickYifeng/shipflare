/**
 * `/api/external-mcp/issue` — POST endpoint that mints a long-lived (30d)
 * JWT for 3rd-party MCP clients (Claude Desktop, Cursor, the founder's own
 * LLM stack).
 *
 * Distinct from `/api/mcp-token` in two ways:
 *  1. Signs with `EXTERNAL_MCP_SECRET`, not `MCP_JWT_SECRET`. A leak in one
 *     domain can't be replayed against the other.
 *  2. TTL is 30 days, not 60 seconds. The token is meant to live in a
 *     `claude_desktop_config.json` on the founder's machine.
 *
 * Token body: `{ userId, role, scope: ExternalScope[] }`. The core Worker
 * verifies `{ userId, role }` against the URL on every request to
 * `/external/agents/<role>/<userId>/mcp`. Scope is recorded for forward-
 * compat per-tool gating (see apps/core/src/lib/external-auth.ts).
 *
 * Auth: requires a Better Auth session cookie. The token is minted for
 * `session.user.id` — founders can only issue tokens for themselves.
 */

import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signJwt } from "@/lib/jwt";

export const dynamic = "force-dynamic";

/** Scopes accepted in the POST body. KEEP IN SYNC with apps/core/src/lib/external-auth.ts. */
const VALID_SCOPES = new Set<string>(["read", "draft", "publish", "admin"]);

/** Role values the UI lets founders issue tokens for. Keep in sync with ROLE_REGISTRY. */
const VALID_ROLES = new Set<string>([
  "cmo",
  "head-of-growth",
  "social-media-manager",
]);

/** 30 days in seconds. */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface IssueRequestBody {
  role: string;
  scope: string[];
}

interface IssueResponseBody {
  token: string;
  mcpUrl: string;
  scope: string[];
  expiresInSeconds: number;
}

export async function POST(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: IssueRequestBody;
  try {
    body = (await req.json()) as IssueRequestBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (typeof body.role !== "string" || !VALID_ROLES.has(body.role)) {
    return new Response("invalid role", { status: 400 });
  }
  if (!Array.isArray(body.scope) || body.scope.length === 0) {
    return new Response("scope must be a non-empty array", { status: 400 });
  }
  for (const s of body.scope) {
    if (typeof s !== "string" || !VALID_SCOPES.has(s)) {
      return new Response(`invalid scope: ${String(s)}`, { status: 400 });
    }
  }

  const { env } = getCloudflareContext();
  const token = await signJwt(
    {
      userId: session.user.id,
      role: body.role,
      scope: body.scope,
    },
    env.EXTERNAL_MCP_SECRET,
    TOKEN_TTL_SECONDS,
  );

  // Fallback origin is dev-only (apps/core's default `wrangler dev` port).
  // Production must set CORE_PUBLIC_URL via `wrangler secret put`.
  const corePublicUrl = env.CORE_PUBLIC_URL ?? "http://localhost:3001";
  const mcpUrl = `${corePublicUrl}/external/agents/${body.role}/${session.user.id}/mcp`;

  const responseBody: IssueResponseBody = {
    token,
    mcpUrl,
    scope: body.scope,
    expiresInSeconds: TOKEN_TTL_SECONDS,
  };
  return Response.json(responseBody);
}
