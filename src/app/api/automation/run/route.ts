import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels, teamMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publishUserEvent } from '@/lib/redis';
import { clearStop } from '@/lib/automation-stop';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { PLATFORMS, isPlatformAvailable } from '@/lib/platform-config';

const baseLog = createLogger('api:automation:run');

/**
 * POST /api/automation/run
 *
 * Manual "launch the agents" entry point. Enqueues one coordinator-rooted
 * team-run (trigger='manual') against the team's rolling 'Discovery'
 * conversation; the coordinator dispatches discovery-agent per platform
 * and community-manager (and content-planner where appropriate) per its playbook.
 */
export async function POST(request: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, request);
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
      { error: 'No product configured. Complete onboarding first.', code: 'NO_PRODUCT' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  // Whitelist projection — we only need platform identity for the goal text.
  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const activePlatforms = [
    ...new Set(userChannels.map((c) => c.platform)),
  ].filter((p) => p in PLATFORMS && isPlatformAvailable(p));

  if (activePlatforms.length === 0) {
    const supported = Object.values(PLATFORMS)
      .map((p) => p.displayName)
      .join(' or ');
    return NextResponse.json(
      { error: `Connect a ${supported} account first.`, code: 'NO_CHANNEL' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  // Clear any stale stop flag from a previous session so the first worker
  // iteration doesn't immediately unwind.
  await clearStop(userId);

  // Publish launch event so the UI shows agents waking up.
  await publishUserEvent(userId, 'agents', {
    type: 'agent_start',
    agentName: 'discovery',
    currentTask: 'Scanning communities...',
  });

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
    `Manual automation kickoff for ${product.name}. ` +
    `Platforms: ${activePlatforms.join(', ')}. ` +
    `Trigger: manual.`;

  const { runId, alreadyRunning } = await enqueueTeamRun({
    teamId,
    trigger: 'manual',
    goal,
    rootMemberId: coordinator.id,
    conversationId,
  });

  log.info(
    `Automation triggered for product "${product.name}" (${product.id}), platforms: ${activePlatforms.join(', ')}, runId=${runId} alreadyRunning=${alreadyRunning}`,
  );

  return NextResponse.json(
    {
      ok: true,
      product: product.name,
      platforms: activePlatforms,
      runId,
      conversationId,
      alreadyRunning,
      traceId,
    },
    { headers: { 'x-trace-id': traceId } },
  );
}
