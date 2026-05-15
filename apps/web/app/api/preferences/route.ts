/**
 * `/api/preferences` — GET and PATCH user preferences stored in D1.
 *
 * Only two fields are managed here: `timezone` and `theme`. All the richer
 * preference fields from the Railway era (autoApprove*, contentMix*,
 * postingHours*, notify*) were intentionally dropped in the CF migration.
 * The D1 schema (`user_preferences` table) owns the source of truth.
 *
 * GET  → returns current preferences (defaults applied if no row exists)
 * PATCH → upserts the supplied fields, returns the resulting row
 *
 * Both verbs are session-gated via Better Auth.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { userPreferences, eq } from "@shipflare/db";

export const dynamic = "force-dynamic";

type PatchBody = Partial<{ timezone: string; theme: "light" | "dark" }>;

export async function GET(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .get();

  return NextResponse.json({
    timezone: row?.timezone ?? "UTC",
    theme: (row?.theme ?? "light") as "light" | "dark",
  });
}

export async function PATCH(req: Request): Promise<Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.theme !== undefined && body.theme !== "light" && body.theme !== "dark") {
    return NextResponse.json({ error: "invalid_theme" }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);
  const now = new Date();

  await db
    .insert(userPreferences)
    .values({
      userId: session.user.id,
      timezone: body.timezone ?? "UTC",
      theme: body.theme ?? "light",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        updatedAt: now,
      },
    });

  // Return the resulting row so the client can sync its SWR cache
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .get();

  return NextResponse.json({
    timezone: row?.timezone ?? "UTC",
    theme: (row?.theme ?? "light") as "light" | "dark",
  });
}
