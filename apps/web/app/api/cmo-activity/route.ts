/**
 * `/api/cmo-activity` — seed-replay proxy for the activity feed.
 *
 * Wires up follow-up #1 of the agent-activity-feed feature (commit
 * fe7170e). The browser's `useCmoActivity` hook calls this on mount
 * and after every WS reconnect to backfill events that fired while
 * the socket was disconnected.
 *
 * Why an HTTP proxy?
 *   The hook originally tried `agent.stub.getRecentActivity(...)` via
 *   the Cloudflare Agents SDK's typed stub. That only exposes methods
 *   decorated with `@callable` — but `getRecentActivity` is registered
 *   as an MCP tool, not a callable RPC. So the stub method was
 *   `undefined` at runtime and seed-replay silently no-op'd.
 *
 *   Rather than promote the tool to a callable (which would split the
 *   source of truth between MCP and RPC surfaces), we keep MCP as the
 *   single canonical interface and let the web Worker proxy through to
 *   it. The pattern mirrors how `/api/mcp-token` mints a session-aware
 *   JWT for the browser's direct MCP connection — except here the web
 *   Worker itself opens an MCP connection on behalf of the verified
 *   founder.
 *
 * Auth: standard Better Auth session check. We don't need to forward
 * the founder's identity beyond that — `createCmoClient()` already
 * derives the per-team MCP URL from the session JWT via the existing
 * `/api/mcp-token` flow when called same-origin from the Worker.
 *
 * Response shape: `{ events: ActivityEvent[] }` — matches what the
 * hook's seed-replay branch expects after the migration.
 */

import { getAuth } from "@/auth";
import { createCmoClient } from "@/lib/mcp-client";

// Force dynamic so each call re-checks the session cookie. Otherwise
// Next.js may attempt to statically prerender and the session lookup
// would short-circuit at build time.
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  const runId = url.searchParams.get("runId");
  if (!conversationId && !runId) {
    return Response.json(
      { error: "conversationId or runId required" },
      { status: 400 },
    );
  }

  // Parse optional bounds. `Number(null) === 0` and `Number('') === 0`,
  // so the absent query param naturally falls through to the defaults
  // enforced server-side (`sinceMs ?? 0`, `limit ?? 200`).
  const sinceMsRaw = url.searchParams.get("sinceMs");
  const limitRaw = url.searchParams.get("limit");
  const sinceMs = sinceMsRaw !== null ? Number(sinceMsRaw) : undefined;
  const limit = limitRaw !== null ? Number(limitRaw) : undefined;
  if (
    (sinceMs !== undefined && !Number.isFinite(sinceMs)) ||
    (limit !== undefined && !Number.isFinite(limit))
  ) {
    return Response.json(
      { error: "sinceMs and limit must be numbers" },
      { status: 400 },
    );
  }

  const client = await createCmoClient();
  try {
    const events = await client.getRecentActivity({
      ...(conversationId ? { conversationId } : {}),
      ...(runId ? { runId } : {}),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return Response.json({ events });
  } finally {
    // Best-effort cleanup — we never want a failed close to mask the
    // happy-path response.
    await client.close().catch(() => undefined);
  }
}
