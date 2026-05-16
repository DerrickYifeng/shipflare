/**
 * `GET /api/channels` — list the caller's connected channels.
 *
 * Used by the onboarding flow (Stage 4) and the settings page to fan out
 * per-platform UI state (Connect/Disconnect buttons, status pills) from a
 * single request.
 *
 * Security: explicit projection that NEVER selects `oauthTokenEncrypted`
 * or `oauthRefreshEncrypted`. Per CLAUDE.md "Security TODO", only the
 * sanctioned helpers in `apps/core/src/lib/channel.ts` may read those
 * columns.
 */

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { channels, eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);

  const rows = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      username: channels.username,
      externalUserId: channels.externalUserId,
      connectedAt: channels.connectedAt,
      lastVerifiedAt: channels.lastVerifiedAt,
      status: channels.status,
    })
    .from(channels)
    .where(eq(channels.userId, session.user.id));

  // Filter to active rows. Revoked/error rows persist for audit but shouldn't
  // surface to the UI as "connected".
  const active = rows.filter((r) => r.status === "active");

  return NextResponse.json({ channels: active });
}
