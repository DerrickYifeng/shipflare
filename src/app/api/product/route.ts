import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, voiceProfiles } from '@/lib/db/schema';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { auditSeo } from '@/tools/seo-audit';
import { acquireRateLimit } from '@/lib/rate-limit';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:product');

// 1 write per 5s per user. PATCH /api/product fans out to SEO audit +
// calibration enqueue on identity changes, so we don't want a click-happy
// settings form to hammer it.
const RATE_LIMIT_WINDOW_SECONDS = 5;

const PLACEHOLDER_NAMES = ['', 'Untitled Product'];
const PLACEHOLDER_DESCS = ['', '-'];

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    keywords: z.array(z.string().min(1)).max(20),
    valueProp: z.string().max(600).nullable(),
    url: z.string().url().nullable(),
    merge: z.boolean(),
  })
  .partial();

/**
 * GET /api/product
 * Returns the authenticated user's product snapshot. Used by the v2 My Product
 * page for SWR revalidation after inline edits. Also surfaces the voice-scan
 * completion timestamp so the identity header can render the VERIFIED badge.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [row] = await db
    .select({
      name: products.name,
      description: products.description,
      keywords: products.keywords,
      valueProp: products.valueProp,
      url: products.url,
      state: products.state,
      launchDate: products.launchDate,
      launchedAt: products.launchedAt,
      targetAudience: products.targetAudience,
      category: products.category,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const [voice] = await db
    .select({ lastExtractedAt: voiceProfiles.lastExtractedAt })
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, session.user.id))
    .orderBy(desc(voiceProfiles.lastExtractedAt))
    .limit(1);

  const state = row.state as ProductState;
  const currentPhase = derivePhase({
    state,
    launchDate: row.launchDate,
    launchedAt: row.launchedAt,
  });

  return NextResponse.json({
    name: row.name,
    description: row.description,
    keywords: row.keywords,
    valueProp: row.valueProp,
    url: row.url,
    state,
    launchDate: row.launchDate ? row.launchDate.toISOString() : null,
    launchedAt: row.launchedAt ? row.launchedAt.toISOString() : null,
    targetAudience: row.targetAudience,
    category: row.category,
    currentPhase,
    updatedAt: row.updatedAt.toISOString(),
    voiceScannedAt: voice?.lastExtractedAt ? voice.lastExtractedAt.toISOString() : null,
  });
}

/**
 * PATCH /api/product
 *
 * Inline product-identity edits from the My Product page + re-scan flows.
 * Replaces the legacy PUT /api/onboarding/profile endpoint. Accepts any
 * subset of { name, description, keywords, valueProp, url, merge }.
 *
 * Semantics:
 *   - `merge=true` (used by website/code rescans) preserves non-placeholder
 *     existing values and unions keyword arrays; `merge=false` (inline edits)
 *     overwrites the provided fields.
 *   - `url` triggers an SEO audit, which is stored on the row.
 *   - If the product's "core identity" (name, description, valueProp,
 *     keywords) changes, the cached discovery onboarding rubric is
 *     evicted so the next discovery-scan regenerates it against the
 *     new product context.
 *   - Phase/state changes do NOT go through here — those hit
 *     POST /api/product/phase which owns the planner replan.
 *
 *   200 { success: true }
 *   400 invalid_request
 *   401 unauthorized
 *   404 no_product (nothing to update — first-time writes come from onboarding/commit)
 *   429 rate_limited
 */
export async function PATCH(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const rl = await acquireRateLimit(`product:patch:${userId}`, RATE_LIMIT_WINDOW_SECONDS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds },
      {
        status: 429,
        headers: {
          'Retry-After': String(rl.retryAfterSeconds),
          'x-trace-id': traceId,
        },
      },
    );
  }

  let body: z.infer<typeof patchBodySchema>;
  try {
    body = patchBodySchema.parse(await request.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'invalid body';
    return NextResponse.json(
      { error: 'invalid_request', detail },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  const [prev] = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      keywords: products.keywords,
      valueProp: products.valueProp,
    })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!prev) {
    return NextResponse.json(
      { error: 'no_product' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  const merge = body.merge ?? false;
  const urlProvided = Object.hasOwn(body, 'url');
  const seoAudit =
    urlProvided && body.url ? await auditSeo(body.url) : null;

  // Resolve final values per field, respecting merge semantics.
  const nameProvided = body.name !== undefined;
  const descProvided = body.description !== undefined;
  const kwProvided = body.keywords !== undefined;
  const vpProvided = body.valueProp !== undefined;

  const finalName = !nameProvided
    ? prev.name
    : merge && !PLACEHOLDER_NAMES.includes(prev.name)
      ? prev.name
      : body.name!;

  const finalDesc = !descProvided
    ? prev.description
    : merge && !PLACEHOLDER_DESCS.includes(prev.description)
      ? prev.description
      : body.description!;

  const finalKeywords = !kwProvided
    ? prev.keywords
    : merge
      ? [...new Set([...prev.keywords, ...(body.keywords ?? [])])]
      : (body.keywords ?? []);

  const finalValueProp = !vpProvided
    ? prev.valueProp
    : merge && prev.valueProp
      ? prev.valueProp
      : (body.valueProp ?? null);

  log.info(`PATCH user=${userId} merge=${merge}`);

  await db
    .update(products)
    .set({
      ...(nameProvided ? { name: finalName } : {}),
      ...(descProvided ? { description: finalDesc } : {}),
      ...(kwProvided ? { keywords: finalKeywords } : {}),
      ...(vpProvided ? { valueProp: finalValueProp } : {}),
      ...(urlProvided ? { url: body.url ?? null } : {}),
      ...(seoAudit !== null ? { seoAuditJson: seoAudit } : {}),
      updatedAt: new Date(),
    })
    .where(eq(products.userId, userId));

  // Discovery v3: if product core changed, delete the cached onboarding
  // rubric so the next discovery-scan regenerates it against the new
  // product context. No calibration / discovery_configs anymore.
  const coreChanged =
    prev.name !== finalName ||
    prev.description !== finalDesc ||
    prev.valueProp !== finalValueProp ||
    JSON.stringify([...prev.keywords].sort()) !==
      JSON.stringify([...finalKeywords].sort());

  if (coreChanged) {
    try {
      const { MemoryStore } = await import('@/memory/store');
      const { ONBOARDING_RUBRIC_MEMORY_NAME } = await import(
        '@/lib/discovery/onboarding-rubric'
      );
      const store = new MemoryStore(userId, prev.id);
      await store.removeEntry(ONBOARDING_RUBRIC_MEMORY_NAME);
      log.info(
        `cleared discovery rubric for product ${prev.id} (core fields changed — will regenerate on next scan)`,
      );
    } catch (err) {
      log.warn(
        `failed to clear discovery rubric for product ${prev.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
