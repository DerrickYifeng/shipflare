import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { threads } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery');

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  log.info('GET /api/discovery');

  const results = await db
    .select()
    .from(threads)
    .where(eq(threads.userId, session.user.id))
    .orderBy(desc(threads.relevanceScore))
    .limit(50);

  return NextResponse.json({
    threads: results.map((t) => ({
      id: t.id,
      externalId: t.externalId,
      subreddit: t.subreddit,
      title: t.title,
      url: t.url,
      relevanceScore: t.relevanceScore,
      createdAt: t.discoveredAt,
    })),
  });
}
