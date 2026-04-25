import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels, teamMembers } from '@/lib/db/schema';
import { isPlatformAvailable } from '@/lib/platform-config';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:discovery:trigger');

/**
 * POST /api/discovery/trigger
 * Manually kick off a discovery scan across all connected platforms by
 * enqueueing a coordinator-rooted team-run (trigger='manual') into the
 * team's rolling 'Discovery' conversation.
 */
export async function POST(req: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, req);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  const [product] = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const connectedPlatforms = [
    ...new Set(userChannels.map((c) => c.platform)),
  ].filter(isPlatformAvailable);

  if (connectedPlatforms.length === 0) {
    return NextResponse.json(
      { error: 'No connected social accounts. Connect at least one platform.' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  const { teamId } = await ensureTeamExists(userId, product.id);
  const memberRows = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
  if (!coordinator) {
    return NextResponse.json(
      { error: 'team_misconfigured', detail: 'coordinator member missing' },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }

  const conversationId = await resolveRollingConversation(teamId, 'Discovery');
  const goal =
    `Manual discovery scan for ${product.name}. ` +
    `Platforms: ${connectedPlatforms.join(', ')}. ` +
    `Trigger: manual.`;

  const { runId, alreadyRunning } = await enqueueTeamRun({
    teamId,
    trigger: 'manual',
    goal,
    rootMemberId: coordinator.id,
    conversationId,
  });

  log.info(
    `Manual discovery triggered: runId=${runId} platforms=${connectedPlatforms.join(',')} alreadyRunning=${alreadyRunning}`,
  );

  return NextResponse.json(
    {
      status: alreadyRunning ? 'already_running' : 'queued',
      runId,
      conversationId,
      platforms: connectedPlatforms,
      traceId,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
