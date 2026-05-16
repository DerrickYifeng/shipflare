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

export async function GET(req: Request): Promise<Response> {
  const { env } = await getCloudflareContext({ async: true });
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
  const { env } = await getCloudflareContext({ async: true });
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  let nextTimezone: string | undefined;
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || body.timezone.length === 0) {
      return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
    }
    nextTimezone = body.timezone;
  }

  let nextTheme: "light" | "dark" | undefined;
  if (body.theme !== undefined) {
    if (body.theme !== "light" && body.theme !== "dark") {
      return NextResponse.json({ error: "invalid_theme" }, { status: 400 });
    }
    nextTheme = body.theme;
  }

  if (nextTimezone === undefined && nextTheme === undefined) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  const db = getDb(env);
  const now = new Date();

  // Merge with existing row so a partial PATCH never clobbers the other
  // field. Without this, a first-time `{ theme: "dark" }` PATCH would
  // permanently write `timezone: "UTC"` even if the user later wants a
  // different timezone.
  const existing = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .get();

  const merged = {
    userId: session.user.id,
    timezone: nextTimezone ?? existing?.timezone ?? "UTC",
    theme: nextTheme ?? existing?.theme ?? "light",
    updatedAt: now,
  } as const;

  await db
    .insert(userPreferences)
    .values(merged)
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        timezone: merged.timezone,
        theme: merged.theme,
        updatedAt: now,
      },
    });

  // Read back so the client can sync its SWR cache. If the row is missing
  // here the upsert silently failed — surface that as 500 instead of
  // returning fabricated defaults.
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .get();

  if (!row) {
    return NextResponse.json({ error: "write_lost" }, { status: 500 });
  }

  return NextResponse.json({
    timezone: row.timezone,
    theme: row.theme as "light" | "dark",
  });
}
