import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xContentCalendar, products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:x:calendar:generate');

/**
 * Content mix ratios: 40% metric, 30% educational, 20% engagement, 10% product.
 * For 2-3 posts/day over 7 days ≈ 18 posts.
 */
const WEEKLY_SLOTS = 18;
const CONTENT_MIX: { type: string; count: number }[] = [
  { type: 'metric', count: 7 },
  { type: 'educational', count: 5 },
  { type: 'engagement', count: 4 },
  { type: 'product', count: 2 },
];

/** Preferred posting hours (UTC): morning, midday, evening. */
const POSTING_HOURS = [14, 17, 21]; // ~9am, 12pm, 4pm EST

/**
 * POST /api/x/calendar/generate
 * Auto-generate a week of calendar entries using content mix ratios.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { startDate?: string; topics?: string[] };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const [product] = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  // Round to start of next hour
  startDate.setMinutes(0, 0, 0);
  startDate.setHours(startDate.getHours() + 1);

  // Build slot pool from content mix
  const pool: string[] = [];
  for (const { type, count } of CONTENT_MIX) {
    for (let i = 0; i < count; i++) {
      pool.push(type);
    }
  }

  // Shuffle pool
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Distribute across 7 days at preferred posting hours
  const entries: {
    userId: string;
    productId: string;
    scheduledAt: Date;
    contentType: string;
    topic: string | null;
  }[] = [];

  let poolIndex = 0;
  for (let day = 0; day < 7 && poolIndex < WEEKLY_SLOTS; day++) {
    for (const hour of POSTING_HOURS) {
      if (poolIndex >= pool.length) break;

      const scheduledAt = new Date(startDate);
      scheduledAt.setDate(scheduledAt.getDate() + day);
      scheduledAt.setHours(hour);

      entries.push({
        userId: session.user.id,
        productId: product.id,
        scheduledAt,
        contentType: pool[poolIndex],
        topic: body.topics?.[poolIndex % (body.topics?.length ?? 1)] ?? null,
      });

      poolIndex++;
    }
  }

  const created = await db
    .insert(xContentCalendar)
    .values(entries)
    .returning();

  log.info(
    `Generated ${created.length} calendar entries for user ${session.user.id}`,
  );

  return NextResponse.json({
    generated: created.length,
    items: created,
  });
}
