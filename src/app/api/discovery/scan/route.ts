import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels, teamMembers } from '@/lib/db/schema';
import { getPlatformConfig, isPlatformAvailable } from '@/lib/platform-config';
import { getKeyValueClient } from '@/lib/redis';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:discovery:scan');
const DEBOUNCE_SECONDS = 120;

/**
 * POST /api/discovery/scan
 * Manual scan with a 2-minute global debounce. Enqueues one
 * coordinator-rooted team-run (trigger='manual') into the team's rolling
 * 'Discovery' conversation; the coordinator dispatches community-scout
 * (and downstream reply-drafter) per its playbook.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const redis = getKeyValueClient();
  const debounceKey = `shipflare:scan:debounce:${userId}`;
  const debounceHit = await redis.set(debounceKey, '1', 'EX', DEBOUNCE_SECONDS, 'NX');
  if (debounceHit === null) {
    const ttl = await redis.ttl(debounceKey);
    return NextResponse.json(
      { error: 'rate_limited', retryAfterSeconds: ttl > 0 ? ttl : DEBOUNCE_SECONDS },
      { status: 429 },
    );
  }

  const [product] = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) {
    await redis.del(debounceKey);
    return NextResponse.json({ error: 'no product' }, { status: 400 });
  }

  // Which platforms does this user actually have connected? Scan only those.
  const connected = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const platforms = [...new Set(connected.map((c) => c.platform))].filter(
    isPlatformAvailable,
  );

  if (platforms.length === 0) {
    await redis.del(debounceKey);
    return NextResponse.json(
      { error: 'no connected channels' },
      { status: 400 },
    );
  }

  const { teamId } = await ensureTeamExists(userId, product.id);
  const memberRows = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
  if (!coordinator) {
    await redis.del(debounceKey);
    return NextResponse.json(
      { error: 'team_misconfigured', detail: 'coordinator member missing' },
      { status: 500 },
    );
  }

  const conversationId = await resolveRollingConversation(teamId, 'Discovery');
  const goal =
    `Manual discovery scan for ${product.name}. ` +
    `Platforms: ${platforms.join(', ')}. ` +
    `Trigger: manual.`;

  const { runId, alreadyRunning } = await enqueueTeamRun({
    teamId,
    trigger: 'manual',
    goal,
    rootMemberId: coordinator.id,
    conversationId,
  });

  // Preserve the per-source preview list so existing callers that render
  // "queued" rows up front (scan-status + SSE consumers) keep working.
  const sources: Array<{ platform: string; source: string }> = [];
  for (const platform of platforms) {
    const config = getPlatformConfig(platform);
    for (const source of config.defaultSources) {
      sources.push({ platform, source });
    }
  }

  log.info(
    `discovery scan team-run enqueued: runId=${runId} platforms=${platforms.join(',')} alreadyRunning=${alreadyRunning}`,
  );

  return NextResponse.json(
    {
      status: alreadyRunning ? 'already_running' : 'queued',
      runId,
      conversationId,
      platforms,
      sources,
    },
    { status: 202 },
  );
}
