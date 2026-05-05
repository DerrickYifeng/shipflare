import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publishUserEvent } from '@/lib/redis';
import { clearStop } from '@/lib/automation-stop';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { dispatchLeadMessage } from '@/lib/team/dispatch-lead-message';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { PLATFORMS, isPlatformAvailable } from '@/lib/platform-config';

const baseLog = createLogger('api:automation:run');

/**
 * POST /api/automation/run
 *
 * Manual "launch the agents" entry point — the same single coordinator
 * playbook the daily-run cron uses. Enqueues one coordinator-rooted
 * team-run (trigger='daily') against the team's rolling 'Discovery'
 * conversation. The goal text encodes "Source: manual" so logs can
 * distinguish user-initiated runs from cron fan-out, but the
 * coordinator's playbook is identical either way.
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

  const conversationId = await resolveRollingConversation(teamId, 'Discovery');
  const goal =
    `Daily automation run for ${product.name}. ` +
    `Connected platforms: ${activePlatforms.join(', ')}. ` +
    `Trigger: daily. Source: manual. ` +
    `Follow your daily playbook: load today's content_reply plan_items ` +
    `for this user, run the per-slot discovery → content-manager loop ` +
    `(max 3 inner attempts per slot), and update_plan_item state='drafted' ` +
    `when each slot terminates. If no slots are found, fall back to ` +
    `default top-3 drafting from a single discovery-agent dispatch.`;

  const { runId, alreadyRunning } = await dispatchLeadMessage(
    {
      teamId,
      conversationId,
      goal,
      trigger: 'daily',
    },
    db,
  );

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
