/**
 * `/api/onboarding/draft` — GET, PUT, and DELETE onboarding draft stored in D1.
 *
 * Onboarding drafts persist product metadata across the multi-step onboarding flow.
 * The D1 schema (`onboarding_drafts` table) owns the source of truth.
 *
 * GET    → returns current draft (null if no row exists)
 * PUT    → merge-upserts the supplied fields, returns the resulting draft
 * DELETE → clears the draft, returns { success: true }
 *
 * All verbs are session-gated via Better Auth.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  getDraft,
  putDraft,
  deleteDraft,
  type OnboardingDraft,
} from "@/lib/onboarding-draft";

export const dynamic = "force-dynamic";

async function requireUserId(req: Request): Promise<string | Response> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return session.user.id;
}

export async function GET(req: Request): Promise<Response> {
  const userOrResp = await requireUserId(req);
  if (userOrResp instanceof Response) return userOrResp;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb(env);
  const draft = await getDraft(db, userOrResp);

  return NextResponse.json({ draft });
}

export async function PUT(req: Request): Promise<Response> {
  const userOrResp = await requireUserId(req);
  if (userOrResp instanceof Response) return userOrResp;

  let patch: unknown;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    patch === null ||
    typeof patch !== "object" ||
    Array.isArray(patch)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb(env);
  const next = await putDraft(db, userOrResp, patch as Partial<OnboardingDraft>);

  return NextResponse.json({ draft: next });
}

export async function DELETE(req: Request): Promise<Response> {
  const userOrResp = await requireUserId(req);
  if (userOrResp instanceof Response) return userOrResp;

  const { env } = await getCloudflareContext({ async: true });
  const db = getDb(env);
  await deleteDraft(db, userOrResp);

  return NextResponse.json({ success: true });
}
