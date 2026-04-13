import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { activityEvents } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:activity');

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  log.info('GET /api/activity');

  const events = await db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.userId, session.user.id))
    .orderBy(desc(activityEvents.createdAt))
    .limit(30);

  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      metadataJson: e.metadataJson,
      createdAt: e.createdAt,
    })),
  });
}
