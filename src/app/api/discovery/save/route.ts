import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { threads } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery:save');

interface ScanResult {
  source: string;
  externalId: string;
  title: string;
  url: string;
  subreddit: string;
  upvotes?: number;
  commentCount?: number;
  relevanceScore: number;
  postedAt?: string | null;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { results: ScanResult[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { results } = body;
  if (!Array.isArray(results) || results.length === 0) {
    return NextResponse.json({ saved: 0 });
  }

  const userId = session.user.id;

  // Deduplicate against existing threads
  const externalIds = results.map((r) => r.externalId);
  const existing = await db
    .select({ externalId: threads.externalId })
    .from(threads)
    .where(
      and(eq(threads.userId, userId), inArray(threads.externalId, externalIds)),
    );

  const existingSet = new Set(existing.map((e) => e.externalId));
  const newResults = results.filter((r) => !existingSet.has(r.externalId));

  if (newResults.length === 0) {
    log.info(`All ${results.length} threads already exist, skipping`);
    return NextResponse.json({ saved: 0 });
  }

  const values = newResults.map((r) => ({
    userId,
    externalId: r.externalId,
    platform: r.source ?? 'reddit',
    subreddit: r.subreddit.replace(/^r\//, ''),
    title: r.title,
    url: r.url,
    upvotes: r.upvotes ?? 0,
    commentCount: r.commentCount ?? 0,
    relevanceScore: (r.relevanceScore ?? 0) / 100, // 0-100 → 0-1
    postedAt: r.postedAt ? new Date(r.postedAt) : null,
  }));

  await db.insert(threads).values(values);

  log.info(`Saved ${values.length} new threads for user ${userId}`);
  return NextResponse.json({ saved: values.length });
}
