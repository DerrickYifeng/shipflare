import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { enqueueSearchSource } from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery:retry-source');

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const body = (await request.json().catch(() => ({}))) as {
    scanRunId?: string;
    platform?: string;
    source?: string;
  };
  if (!body.scanRunId || !body.platform || !body.source) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) {
    return NextResponse.json({ error: 'no product' }, { status: 400 });
  }

  const jobId = await enqueueSearchSource({
    schemaVersion: 1,
    traceId: randomUUID(),
    userId,
    productId: product.id,
    platform: body.platform,
    source: body.source,
    scanRunId: body.scanRunId,
  });

  log.info(`retry-source enqueued: jobId=${jobId}`);
  return NextResponse.json({ status: 'queued', jobId }, { status: 202 });
}
