import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xContentCalendar, products } from '@/lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:x:calendar');

/**
 * GET /api/x/calendar
 * List calendar items (upcoming + past) for the user.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const range = searchParams.get('range') ?? '7d';
  const days = range === '30d' ? 30 : range === '14d' ? 14 : 7;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const items = await db
    .select()
    .from(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.userId, session.user.id),
        gte(xContentCalendar.scheduledAt, since),
      ),
    )
    .orderBy(desc(xContentCalendar.scheduledAt))
    .limit(100);

  return NextResponse.json({ items });
}

/**
 * POST /api/x/calendar
 * Create or update a calendar entry.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    id?: string;
    scheduledAt?: string;
    contentType?: string;
    topic?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const validTypes = ['metric', 'educational', 'engagement', 'product', 'thread'];
  if (body.contentType && !validTypes.includes(body.contentType)) {
    return NextResponse.json(
      { error: `Invalid contentType. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 },
    );
  }

  // Update existing
  if (body.id) {
    const [existing] = await db
      .select()
      .from(xContentCalendar)
      .where(
        and(
          eq(xContentCalendar.id, body.id),
          eq(xContentCalendar.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Calendar item not found' }, { status: 404 });
    }

    await db
      .update(xContentCalendar)
      .set({
        ...(body.scheduledAt ? { scheduledAt: new Date(body.scheduledAt) } : {}),
        ...(body.contentType ? { contentType: body.contentType } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        updatedAt: new Date(),
      })
      .where(eq(xContentCalendar.id, body.id));

    return NextResponse.json({ success: true });
  }

  // Create new
  if (!body.scheduledAt || !body.contentType) {
    return NextResponse.json(
      { error: 'scheduledAt and contentType are required' },
      { status: 400 },
    );
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  const [item] = await db
    .insert(xContentCalendar)
    .values({
      userId: session.user.id,
      productId: product.id,
      scheduledAt: new Date(body.scheduledAt),
      contentType: body.contentType,
      topic: body.topic ?? null,
    })
    .returning();

  log.info(`Created calendar item ${item.id} for user ${session.user.id}`);
  return NextResponse.json({ item });
}

/**
 * DELETE /api/x/calendar
 * Cancel a scheduled post.
 */
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { itemId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.itemId) {
    return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
  }

  const [item] = await db
    .select()
    .from(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.id, body.itemId),
        eq(xContentCalendar.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: 'Calendar item not found' }, { status: 404 });
  }

  await db
    .update(xContentCalendar)
    .set({ status: 'skipped', updatedAt: new Date() })
    .where(eq(xContentCalendar.id, body.itemId));

  log.info(`Cancelled calendar item ${body.itemId} for user ${session.user.id}`);
  return NextResponse.json({ success: true });
}
