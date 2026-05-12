/**
 * GET / POST / PATCH /api/reddit-channels
 *
 * CRUD-style surface over `product_reddit_channels` for the founder. The
 * onboarding "Reddit communities" card and the future settings page both
 * read GET and mutate via POST (add manual) / PATCH (toggle disabled).
 *
 * Auth: every route requires a signed-in session and the user must own a
 * product. We never accept productId from the client — it's derived from
 * the session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import {
  listAllSubreddits,
  setSubredditDisabled,
  upsertManualSubreddit,
} from '@/lib/db/repositories/product-reddit-channels';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:reddit-channels');

/**
 * Reddit display names: 3-21 chars, letters / digits / underscore.
 * Mirrors the platform's own subreddit-name rules; both the server route
 * and the client form validate against the same source of truth.
 */
const SUBREDDIT_REGEX = /^[A-Za-z0-9_]{3,21}$/;

async function findUserProductId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  return row?.id ?? null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const { traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-trace-id': traceId } },
    );
  }
  const productId = await findUserProductId(session.user.id);
  if (!productId) {
    return NextResponse.json(
      { error: 'no_product' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }
  const channels = await listAllSubreddits(productId);
  return NextResponse.json({ channels }, { headers: { 'x-trace-id': traceId } });
}

const postBodySchema = z.object({
  subreddit: z.string().regex(SUBREDDIT_REGEX),
});

export async function POST(request: NextRequest): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-trace-id': traceId } },
    );
  }
  const productId = await findUserProductId(session.user.id);
  if (!productId) {
    return NextResponse.json(
      { error: 'no_product' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }
  const raw = await request.json().catch(() => null);
  const parsed = postBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_subreddit',
        detail: parsed.error.issues[0]?.message ?? 'bad shape',
      },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  await upsertManualSubreddit({
    productId,
    userId: session.user.id,
    subreddit: parsed.data.subreddit,
  });
  log.info(
    `upserted manual subreddit ${parsed.data.subreddit} for product ${productId}`,
  );
  return NextResponse.json(
    { ok: true },
    { headers: { 'x-trace-id': traceId } },
  );
}

const patchBodySchema = z.object({
  subreddit: z.string().regex(SUBREDDIT_REGEX),
  disabled: z.boolean(),
});

export async function PATCH(request: NextRequest): Promise<Response> {
  const { traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-trace-id': traceId } },
    );
  }
  const productId = await findUserProductId(session.user.id);
  if (!productId) {
    return NextResponse.json(
      { error: 'no_product' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }
  const raw = await request.json().catch(() => null);
  const parsed = patchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        detail: parsed.error.issues[0]?.message ?? 'bad shape',
      },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  await setSubredditDisabled(
    productId,
    parsed.data.subreddit,
    parsed.data.disabled,
  );
  return NextResponse.json(
    { ok: true },
    { headers: { 'x-trace-id': traceId } },
  );
}
