import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { products, eq } from "@shipflare/db";
import { getDb } from "@/db";
import { getAuth } from "@/auth";
import type { StrategicPath } from "@shipflare/shared";
import { derivePhase } from "@/lib/launch-phase";
import { validateLaunchDates } from "@/lib/launch-date-rules";
import { deleteDraft } from "@/lib/onboarding-draft";

export const dynamic = "force-dynamic";

const requestBodySchema = z.object({
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    valueProp: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20),
    category: z.enum([
      "dev_tool",
      "saas",
      "consumer",
      "creator_tool",
      "agency",
      "ai_app",
      "other",
    ]),
    targetAudience: z.string().max(600).nullable().optional(),
    url: z.string().url().nullable().optional(),
  }),
  state: z.enum(["mvp", "launching", "launched"]),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  launchChannel: z
    .enum(["producthunt", "showhn", "both", "other"])
    .nullable()
    .optional(),
  usersBucket: z
    .enum(["<100", "100-1k", "1k-10k", "10k+"])
    .nullable()
    .optional(),
  // path is a StrategicPath object validated by apps/core before it reaches
  // the browser. We accept it as unknown here and cast — cross-workspace Zod
  // v3/v4 mismatch prevents using the v4 schema from @shipflare/shared directly
  // inside a v3 z.object() call.
  path: z.unknown(),
});

type RequestBody = Omit<z.infer<typeof requestBodySchema>, "path"> & {
  path: StrategicPath;
};

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: RequestBody;
  try {
    body = requestBodySchema.parse(await req.json()) as RequestBody;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid body";
    return NextResponse.json(
      { error: "invalid_request", detail },
      { status: 400 },
    );
  }

  const dateErrors = validateLaunchDates({
    state: body.state,
    launchDate: body.launchDate ?? null,
    launchedAt: body.launchedAt ?? null,
  });
  if (dateErrors.length > 0) {
    return NextResponse.json(
      { error: "invalid_dates", detail: dateErrors },
      { status: 400 },
    );
  }

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  // derivePhase used for logging/observability only — products.state is persisted
  const _phase = derivePhase({ state: body.state, launchDate, launchedAt });
  const now = new Date();

  const { env } = getCloudflareContext();
  const db = getDb(env);

  try {
    const existing = await db
      .select()
      .from(products)
      .where(eq(products.userId, userId))
      .get();

    const merged = {
      userId,
      name: body.product.name,
      description: body.product.description,
      valueProp: body.product.valueProp ?? null,
      keywords: body.product.keywords,
      url: body.product.url ?? null,
      category: body.product.category,
      targetAudience: body.product.targetAudience ?? null,
      state: body.state,
      launchDate,
      launchedAt,
      launchChannel: body.launchChannel ?? null,
      usersBucket: body.usersBucket ?? null,
      onboardingCompletedAt: now,
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
          keywords: merged.keywords,
          url: merged.url,
          category: merged.category,
          targetAudience: merged.targetAudience,
          state: merged.state,
          launchDate: merged.launchDate,
          launchedAt: merged.launchedAt,
          launchChannel: merged.launchChannel,
          usersBucket: merged.usersBucket,
          onboardingCompletedAt: merged.onboardingCompletedAt,
          updatedAt: merged.updatedAt,
        },
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`commit product upsert failed user=${userId}:`, message);
    return NextResponse.json(
      { error: "commit_failed", detail: message },
      { status: 500 },
    );
  }

  // Best-effort: ship the strategic path to CMO DO via service binding.
  // Non-fatal — if this fails, the founder can re-generate from /settings.
  try {
    const initRes = await env.CORE.fetch(
      `https://internal/agents/cmo/${encodeURIComponent(userId)}/internal/commit-strategic-path`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shipflare-internal": "1",
        },
        body: JSON.stringify({
          theme: body.path.contentPillars[0] ?? "Launch",
          narrative: body.path,
          generatedBy: "onboarding",
        }),
      },
    );
    if (!initRes.ok) {
      console.warn(
        `commit: CMO commit-strategic-path returned ${initRes.status} for ${userId}`,
      );
    }
  } catch (err) {
    console.warn(
      `commit: CMO commit-strategic-path threw for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Clear the draft (idempotent).
  try {
    await deleteDraft(db, userId);
  } catch (err) {
    console.warn(
      `commit: deleteDraft failed for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({
    success: true,
    conversationId: null,
  });
}
