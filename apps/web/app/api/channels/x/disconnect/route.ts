/**
 * `DELETE /api/channels/x/disconnect` — removes the user's X channel row.
 *
 * Called from the onboarding and settings pages when the founder wants to
 * unlink their X account. Tokens are discarded with the row; the user must
 * re-authorise via `/api/channels/x/connect` to reconnect.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { channels, eq, and } from "@shipflare/db";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);

  await db
    .delete(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, "x"),
      ),
    );

  return NextResponse.json({ success: true });
}
