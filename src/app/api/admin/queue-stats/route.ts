// Phase B7 — admin observability endpoint.
//
// Surfaces real-time queue health so an operator can see at a glance:
//   - Per-lane BullMQ depth (priority / standard / backfill after B6)
//   - Per-tenant in-flight count (B3 tenant-semaphore reads)
//   - Anthropic token-bucket fill (B5 hierarchical rate limit)
//
// Auth: admin-only via the existing `isAdminEmail` allowlist
// (`ADMIN_EMAILS` env). Mirrors the gate used by `(app)/admin/layout.tsx`.
// Returns 404 (not 403) on non-admin to avoid advertising the surface.

import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdminEmail } from '@/lib/admin';
import { getKeyValueClient } from '@/lib/redis';
import { getAgentRunQueueStats } from '@/lib/queue/agent-run';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface TenantInflight {
  userId: string;
  inflight: number;
}

interface QueueStatsResponse {
  queueCountsByLane: Awaited<ReturnType<typeof getAgentRunQueueStats>>;
  inflightByTenant: TenantInflight[];
  llmBucket: {
    global: { tokens: number | null; tsMs: number | null };
    tenantCount: number;
  };
  timestamp: string;
}

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!isAdminEmail(email)) {
    // 404 (not 403) — same UX as `(app)/admin/layout.tsx`; don't
    // advertise the admin surface to non-admins.
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const redis = getKeyValueClient();

  const [queueCountsByLane, inflightByTenant, llmBucket] = await Promise.all([
    getAgentRunQueueStats(),
    collectInflightByTenant(redis),
    collectLlmBucketSnapshot(redis),
  ]);

  const body: QueueStatsResponse = {
    queueCountsByLane,
    inflightByTenant,
    llmBucket,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, { headers: NO_STORE_HEADERS });
}

/**
 * Scan the per-tenant in-flight keys written by the B3 tenant
 * semaphore. Key shape: `inflight:agent:${userId}` (single source of
 * truth in `src/lib/redis-scripts/tenant-semaphore.ts:inflightKey`).
 *
 * Uses SCAN with a small page size — KEYS on production Redis can
 * block the server, but our key space here is bounded by active
 * tenants so the iteration completes in a single round-trip on any
 * realistic deployment.
 */
async function collectInflightByTenant(
  redis: ReturnType<typeof getKeyValueClient>,
): Promise<TenantInflight[]> {
  const pattern = 'inflight:agent:*';
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  return keys.map((key, i) => ({
    userId: key.slice('inflight:agent:'.length),
    inflight: parseInt(values[i] ?? '0', 10) || 0,
  }));
}

/**
 * Read the Anthropic global token-bucket head + count distinct tenant
 * buckets. Bucket key shapes are owned by
 * `src/lib/redis-scripts/llm-token-bucket.ts` — see file headers.
 */
async function collectLlmBucketSnapshot(
  redis: ReturnType<typeof getKeyValueClient>,
): Promise<QueueStatsResponse['llmBucket']> {
  const globalReply = await redis.hmget('llm:global:anthropic', 't', 'ts');
  const tokens = globalReply[0] !== null ? parseFloat(globalReply[0]) : null;
  const tsMs = globalReply[1] !== null ? parseInt(globalReply[1], 10) : null;

  // Count tenant buckets via SCAN (same rationale as inflight scan).
  let tenantCount = 0;
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'llm:tenant:*', 'COUNT', 100);
    cursor = next;
    tenantCount += batch.length;
  } while (cursor !== '0');

  return {
    global: {
      tokens: tokens !== null && Number.isFinite(tokens) ? tokens : null,
      tsMs: tsMs !== null && Number.isFinite(tsMs) ? tsMs : null,
    },
    tenantCount,
  };
}
