/**
 * `/api/account` — account-level operations.
 *
 * DELETE — hard-delete the authenticated user's account.
 *
 * Sequence:
 *   1. Best-effort: POST `/internal/destroy` to each agent DO (CMO, HoG, SMM)
 *      to wipe per-DO SQLite. Failures are logged but do NOT block step 3.
 *   2. Delete all active sessions for this user from D1 so cookies become
 *      invalid immediately. (D1 also cascades on user deletion, but explicit
 *      deletion BEFORE the user row ensures the cookie is dead before the
 *      response lands.)
 *   3. Delete the user row from D1. D1 ON DELETE CASCADE fires for:
 *      session, account, verification, channels, products, user_preferences,
 *      growth_snapshots.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { user as userTable, session as sessionTable, eq } from "@shipflare/db";

export const dynamic = "force-dynamic";

/**
 * The three employee DOs that hold per-tenant SQLite state.
 * Platform tool MCPs (X_MCP / REDDIT_MCP) are excluded — they are
 * lazily-created leaf DOs with no durable business state beyond rate-limit
 * and cache tables, and they are keyed by the same userId so they will be
 * orphaned and inert once the user row is gone.
 */
const AGENTS_TO_DESTROY = [
  "cmo",
  "head-of-growth",
  "social-media-manager",
] as const;

/**
 * Best-effort: tell the given agent DO to wipe its per-user SQLite.
 *
 * The request goes through the `CORE` service binding, which routes
 * `/agents/<role>/<userId>/internal/destroy` to the DO's fetch handler via
 * the existing INTERNAL_ROUTE pattern in apps/core/src/index.ts.
 * The `x-shipflare-internal: 1` header is required by both the Worker-level
 * gate and the DO's own fetch handler.
 *
 * A failure here is logged but DOES NOT prevent the D1 deletion below.
 */
async function destroyAgentState(
  env: CloudflareEnv,
  userId: string,
  agent: string,
): Promise<void> {
  try {
    const res = await env.CORE.fetch(
      `https://internal/agents/${agent}/${userId}/internal/destroy`,
      {
        method: "POST",
        headers: { "x-shipflare-internal": "1" },
      },
    );
    if (!res.ok) {
      console.warn(
        `[account-delete] ${agent}/${userId} destroy returned ${res.status}`,
      );
    }
  } catch (err) {
    console.warn(`[account-delete] ${agent}/${userId} destroy failed:`, err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const { env } = getCloudflareContext();

  // 1. Best-effort: wipe per-DO SQLite for each agent (don't await serially —
  //    run in parallel and swallow failures).
  await Promise.all(
    AGENTS_TO_DESTROY.map((agent) => destroyAgentState(env, userId, agent)),
  );

  const db = getDb(env);

  // 2. Delete all sessions for this user so their cookies become immediately
  //    invalid. D1 cascades this on user deletion too, but explicit deletion
  //    BEFORE the user row ensures the client is logged out before the
  //    response returns.
  await db.delete(sessionTable).where(eq(sessionTable.userId, userId));

  // 3. Delete the user row. D1 ON DELETE CASCADE fires for all related tables:
  //    account, verification, channels, products, user_preferences,
  //    growth_snapshots.
  await db.delete(userTable).where(eq(userTable.id, userId));

  return NextResponse.json({ ok: true });
}
