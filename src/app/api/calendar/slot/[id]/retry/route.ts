import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xContentCalendar } from '@/lib/db/schema';
import { enqueueCalendarSlotDraft } from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:calendar:slot:retry');

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const [item] = await db
    .select()
    .from(xContentCalendar)
    .where(and(eq(xContentCalendar.id, id), eq(xContentCalendar.userId, userId)))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  await db
    .update(xContentCalendar)
    .set({ state: 'queued', retryCount: (item.retryCount ?? 0) + 1 })
    .where(eq(xContentCalendar.id, id));

  const jobId = await enqueueCalendarSlotDraft({
    schemaVersion: 1,
    traceId: randomUUID(),
    userId,
    productId: item.productId,
    calendarItemId: id,
    channel: item.channel,
  });

  log.info(`slot retry enqueued: calendarItemId=${id} jobId=${jobId}`);
  return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
}
