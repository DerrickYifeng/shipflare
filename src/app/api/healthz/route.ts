import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:healthz');

export const dynamic = 'force-dynamic';

/**
 * Public liveness probe for Railway and other orchestrators.
 *
 * `/api/healthz` (Kubernetes convention) is unauthenticated and pings the
 * two dependencies a worker request actually needs: Postgres and Redis.
 * Returns 200 only when both are up, 503 otherwise. The existing
 * `/api/health` endpoint is an authenticated app-level health-score view
 * and stays where it is.
 */
export async function GET() {
  const [dbOk, redisOk] = await Promise.all([pingDb(), pingRedis()]);
  const ok = dbOk && redisOk;
  const body = {
    ok,
    db: dbOk,
    redis: redisOk,
    ts: new Date().toISOString(),
  };
  if (!ok) {
    log.error(`healthz failing: db=${dbOk} redis=${redisOk}`);
    return NextResponse.json(body, { status: 503 });
  }
  return NextResponse.json(body);
}

async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (err: unknown) {
    log.error(
      'healthz db ping failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function pingRedis(): Promise<boolean> {
  try {
    const kv = getKeyValueClient();
    const reply = await kv.ping();
    return reply === 'PONG';
  } catch (err: unknown) {
    log.error(
      'healthz redis ping failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
