/**
 * `/api/product` — GET and PATCH the user's product profile stored in D1.
 *
 * The product table is keyed by `userId` (one row per user). All fields
 * except `userId`, `launchedAt`, and `createdAt` are user-editable via PATCH.
 * `launchedAt` is set by a future "I launched!" action, not via this route.
 *
 * GET  → returns the current product row (or sensible defaults if no row exists)
 * PATCH → validates and merges supplied fields, upserts, returns the resulting row
 *
 * Both verbs are session-gated via Better Auth.
 */

import { NextResponse } from "next/server";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { products, eq } from "@shipflare/db";

export const dynamic = "force-dynamic";

type ProductState = "mvp" | "launching" | "launched";
const PRODUCT_STATES: readonly ProductState[] = [
  "mvp",
  "launching",
  "launched",
] as const;

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
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  if (!row) {
    // Return defaults — no row yet for this user.
    return NextResponse.json({
      userId: session.user.id,
      name: null,
      description: null,
      keywords: [],
      valueProp: null,
      url: null,
      state: "mvp" as ProductState,
      launchDate: null,
      launchedAt: null,
    });
  }

  return NextResponse.json(row);
}

export async function PATCH(req: Request): Promise<Response> {
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

  // Narrow each editable field. `null` is accepted as a deliberate clear for
  // nullable string fields. Unknown field types are rejected with 400.
  const patch: {
    name?: string | null;
    description?: string | null;
    valueProp?: string | null;
    url?: string | null;
    keywords?: string[];
    state?: ProductState;
    launchDate?: Date | null;
  } = {};

  if ("name" in body) {
    if (body.name !== null && typeof body.name !== "string") {
      return NextResponse.json({ error: "invalid_name" }, { status: 400 });
    }
    patch.name = body.name as string | null;
  }

  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      return NextResponse.json(
        { error: "invalid_description" },
        { status: 400 },
      );
    }
    patch.description = body.description as string | null;
  }

  if ("valueProp" in body) {
    if (body.valueProp !== null && typeof body.valueProp !== "string") {
      return NextResponse.json({ error: "invalid_valueProp" }, { status: 400 });
    }
    patch.valueProp = body.valueProp as string | null;
  }

  if ("url" in body) {
    if (body.url !== null && typeof body.url !== "string") {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    patch.url = body.url as string | null;
  }

  if ("keywords" in body) {
    if (
      !Array.isArray(body.keywords) ||
      !body.keywords.every((k) => typeof k === "string")
    ) {
      return NextResponse.json({ error: "invalid_keywords" }, { status: 400 });
    }
    patch.keywords = body.keywords as string[];
  }

  if ("state" in body) {
    if (
      typeof body.state !== "string" ||
      !PRODUCT_STATES.includes(body.state as ProductState)
    ) {
      return NextResponse.json({ error: "invalid_state" }, { status: 400 });
    }
    patch.state = body.state as ProductState;
  }

  if ("launchDate" in body) {
    if (body.launchDate === null) {
      patch.launchDate = null;
    } else if (typeof body.launchDate === "number") {
      // Accept Unix seconds from the frontend product page.
      patch.launchDate = new Date(body.launchDate * 1000);
    } else {
      return NextResponse.json(
        { error: "invalid_launchDate" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);
  const now = new Date();

  // Merge with the existing row so a partial PATCH never clobbers omitted
  // fields. Without this, a first-time `{ name: "Foo" }` PATCH would
  // permanently lose any state the row already had.
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  const merged = {
    userId: session.user.id,
    name:
      patch.name !== undefined ? patch.name : (existing?.name ?? null),
    description:
      patch.description !== undefined
        ? patch.description
        : (existing?.description ?? null),
    valueProp:
      patch.valueProp !== undefined
        ? patch.valueProp
        : (existing?.valueProp ?? null),
    url: patch.url !== undefined ? patch.url : (existing?.url ?? null),
    keywords:
      patch.keywords !== undefined
        ? patch.keywords
        : (existing?.keywords ?? []),
    state: (
      patch.state !== undefined
        ? patch.state
        : (existing?.state ?? "mvp")
    ) as ProductState,
    launchDate:
      patch.launchDate !== undefined
        ? patch.launchDate
        : (existing?.launchDate ?? null),
    // launchedAt is NOT user-settable — preserved from existing row only.
    launchedAt: existing?.launchedAt ?? null,
    // Onboarding-owned fields. The PATCH route doesn't accept these from
    // clients, but they're written by /api/onboarding/commit. Preserve the
    // existing values across the upsert so a product-page PATCH doesn't
    // clobber them to NULL.
    category: existing?.category ?? null,
    targetAudience: existing?.targetAudience ?? null,
    launchChannel: existing?.launchChannel ?? null,
    usersBucket: existing?.usersBucket ?? null,
    onboardingCompletedAt: existing?.onboardingCompletedAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await db
    .insert(products)
    .values(merged)
    .onConflictDoUpdate({
      target: products.userId,
      set: {
        name: merged.name,
        description: merged.description,
        valueProp: merged.valueProp,
        url: merged.url,
        keywords: merged.keywords,
        category: merged.category,
        targetAudience: merged.targetAudience,
        state: merged.state,
        launchDate: merged.launchDate,
        launchChannel: merged.launchChannel,
        usersBucket: merged.usersBucket,
        onboardingCompletedAt: merged.onboardingCompletedAt,
        updatedAt: now,
      },
    });

  // Read back to confirm the upsert landed. If null here, surface as 500
  // rather than returning fabricated data.
  const row = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  if (!row) {
    return NextResponse.json({ error: "write_lost" }, { status: 500 });
  }

  return NextResponse.json(row);
}
