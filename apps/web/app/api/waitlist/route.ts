/**
 * POST /api/waitlist — public signup endpoint for the alpha waitlist.
 *
 * Idempotent on email: same address submitting twice returns 200 with the
 * existing row's id, never errors. The /waitlist page client calls this
 * after validating the email shape; we re-validate server-side because
 * never trust the client.
 *
 * Persistence lives in `waitlist_signups` (D1). Admins triage entries at
 * /admin/invites → Waitlist tab; approving creates an `allowed_emails`
 * row which lets the address through Better Auth's
 * databaseHooks.user.create.before gate.
 */

import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { waitlistSignups, eq } from "@shipflare/db";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const email = (raw as { email?: unknown }).email;
  if (typeof email !== "string" || email.length === 0 || email.length > 254) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb(env);

  // Look first so duplicate submits return the existing id without churning
  // the UNIQUE index. D1 does support INSERT ... ON CONFLICT DO NOTHING but
  // the SELECT-then-INSERT keeps the contract explicit and lets us return
  // a stable id for future client-side correlation.
  const existing = await db
    .select({ id: waitlistSignups.id })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.email, normalized))
    .get();
  if (existing) {
    return NextResponse.json({ id: existing.id, status: "already_listed" });
  }

  const id = crypto.randomUUID();
  await db.insert(waitlistSignups).values({
    id,
    email: normalized,
    submittedAt: new Date(),
  });

  return NextResponse.json({ id, status: "submitted" }, { status: 201 });
}
