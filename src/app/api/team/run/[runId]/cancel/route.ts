import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, inArray, not } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamRuns } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import {
  teamCancelChannel,
  teamMessagesChannel,
} from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:run:cancel');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/team/run/[runId]/cancel
 *
 * Abort a running team_run. Publishes on the per-run cancel channel;
 * the worker subscriber calls its `AbortController.abort()`, which
 * flows through runAgent into the Anthropic SDK. The worker settles
 * the run with `status='cancelled'` in its own catch path.
 *
 * Idempotent: calling cancel on a run that's already terminal is a
 * 200 no-op so the button can't get stuck in a retry loop.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const { runId } = await params;

  // Resolve the run → its team → verify the caller owns the team.
  // One query with an inArray keeps the check cheap; we don't expose
  // which half failed so a cross-tenant attacker can't probe run ids.
  const rows = await db
    .select({
      runId: teamRuns.id,
      teamId: teamRuns.teamId,
      status: teamRuns.status,
      ownerId: teams.userId,
    })
    .from(teamRuns)
    .innerJoin(teams, eq(teams.id, teamRuns.teamId))
    .where(and(inArray(teamRuns.id, [runId]), eq(teams.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  }
  const run = rows[0];

  // Already terminal — no worker to signal, just confirm the state.
  if (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  ) {
    return NextResponse.json(
      { runId: run.runId, status: run.status, alreadyTerminal: true },
      { status: 200 },
    );
  }

  // Best-effort cancel, three lanes in parallel. Any lane working keeps
  // the user's intent visible:
  //   1. DB flip (`status='cancelled'`) — authoritative, survives
  //      worker crashes. Conditional on the row not already being
  //      terminal to avoid racing the happy path.
  //   2. SSE terminal broadcast — UI flips the session rail + thread
  //      immediately, no waiting on the worker.
  //   3. Redis cancel channel — worker's AbortController fires so the
  //      in-flight Anthropic stream unwinds and we stop burning tokens.
  //
  // Without lane 1+2 a stale worker (bun --watch missing a reload,
  // crashed process, lane 3 subscribed with 0 listeners) would leave
  // the button click apparently dead. The worker's own markCancelled/
  // markFailed still guard against overwriting a cancelled row — see
  // the conditional `where` below and the matching worker update.
  try {
    await db
      .update(teamRuns)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          eq(teamRuns.id, run.runId),
          not(inArray(teamRuns.status, ['completed', 'failed', 'cancelled'])),
        ),
      );
  } catch (err) {
    log.warn(
      `DB cancel update failed for ${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await getPubSubPublisher().publish(
      teamMessagesChannel(run.teamId),
      JSON.stringify({
        messageId: crypto.randomUUID(),
        runId: run.runId,
        teamId: run.teamId,
        from: null,
        to: null,
        type: 'error',
        content: 'Run cancelled by user.',
        metadata: { cancelled: true, initiatedBy: 'user' },
        createdAt: new Date().toISOString(),
      }),
    );
  } catch (err) {
    log.warn(
      `SSE cancel broadcast failed for ${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await getPubSubPublisher().publish(
      teamCancelChannel(run.teamId, run.runId),
      JSON.stringify({ at: Date.now() }),
    );
  } catch (err) {
    log.warn(
      `Redis cancel signal failed for ${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Don't fail the request — lanes 1+2 already flipped the UI. The
    // worker will either self-terminate on its own turn budget or the
    // next status-mismatch read.
  }

  log.info(`POST /api/team/run/${run.runId}/cancel user=${userId}`);
  return NextResponse.json(
    { runId: run.runId, status: 'cancelled' },
    { status: 202 },
  );
}
