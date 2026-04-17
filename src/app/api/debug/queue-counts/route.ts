import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  calendarSlotDraftQueue,
  searchSourceQueue,
  discoveryScanQueue,
  contentQueue,
} from '@/lib/queue';
import type { Queue } from 'bullmq';

/**
 * Dev/staging-only queue inspection used by E2E decoupling tests.
 * Returns raw BullMQ counts (waiting/active/completed/failed/delayed/...)
 * plus a derived `total` so tests can assert "no scan jobs were enqueued"
 * without poking Redis directly.
 *
 * Hard-disabled in production (404) — there is no reason for this to be
 * reachable on a customer-facing deployment.
 */
export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'disabled' }, { status: 404 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const counts = async (q: Queue): Promise<Record<string, number>> => {
    const c = await q.getJobCounts();
    const total = Object.values(c).reduce<number>(
      (acc, v) => acc + (typeof v === 'number' ? v : 0),
      0,
    );
    return { total, ...c };
  };

  return NextResponse.json({
    calendarSlotDraft: await counts(calendarSlotDraftQueue),
    searchSource: await counts(searchSourceQueue),
    discoveryScan: await counts(discoveryScanQueue),
    content: await counts(contentQueue),
  });
}
