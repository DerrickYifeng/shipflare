import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMessages } from '@/lib/db/schema';
import { findLeadAgentId } from '@/lib/team/find-lead-agent';
import { wake } from '@/workers/processors/lib/wake';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:run:cancel');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/team/run/[runId]/cancel
 *
 * Phase E (Agent Teams): cancellation is a `shutdown_request` mailbox row
 * addressed to the team's lead agent. The lead's agent-run loop drains its
 * mailbox at the next idle turn, observes the `shutdown_request`, and
 * exits gracefully with `agent_runs.status='killed'` (Phase C Task 7).
 *
 * Note on `runId`: since Phase E Task 3 the value here is a
 * `team_messages.id` (the user-prompt message that originally triggered
 * the lead), not a legacy `team_runs.id`. We look up the message → its
 * team → verify the caller owns it, then route the shutdown to the lead.
 *
 * Behaviour change vs. the legacy flow: previously the route flipped
 * `team_runs.status='cancelled'` synchronously and published a Redis
 * cancel signal so the worker's AbortController fired immediately.
 * Phase E is eventually consistent — the lead processes the shutdown on
 * its next turn boundary (typically within seconds). Callers should treat
 * the 202 response as "shutdown requested" rather than "cancelled now".
 *
 * Idempotent: if no lead agent_runs row exists for the team (e.g. it
 * already exited), the route still 202s — the message we'd insert would
 * have nowhere to deliver, so we skip the insert and return success so
 * the UI button doesn't get stuck in a retry loop.
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
  const { runId: messageId } = await params;

  // Resolve the message → its team → verify the caller owns the team.
  // One inner-join keeps the auth check cheap; we don't expose which
  // half failed so a cross-tenant attacker can't probe message ids.
  const rows = await db
    .select({
      messageId: teamMessages.id,
      teamId: teamMessages.teamId,
    })
    .from(teamMessages)
    .innerJoin(teams, eq(teams.id, teamMessages.teamId))
    .where(and(eq(teamMessages.id, messageId), eq(teams.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'run_not_found' }, { status: 404 });
  }
  const { teamId } = rows[0];

  // Resolve the lead. If absent (e.g. lead already exited / team has no
  // coordinator member), there's no recipient for the shutdown_request —
  // 202 idempotently rather than 404, so the UI doesn't surface a confusing
  // error after a successful natural completion.
  const leadAgentId = await findLeadAgentId(teamId, db);
  if (leadAgentId === null) {
    log.info(
      `POST /api/team/run/${messageId}/cancel user=${userId} team=${teamId} ` +
        `no lead agent_run found — treating as already terminal`,
    );
    return NextResponse.json(
      { runId: messageId, status: 'cancelled', alreadyTerminal: true },
      { status: 200 },
    );
  }

  // Insert a shutdown_request mailbox row for the lead. The lead's
  // agent-run loop (Phase C Task 7) drains pending mail at idle-turn
  // boundaries; on shutdown_request it sets a graceful-exit flag,
  // unwinds the current turn, and settles status='killed'.
  await db.insert(teamMessages).values({
    teamId,
    type: 'user_prompt',
    messageType: 'shutdown_request',
    fromMemberId: null, // founder-originated
    toAgentId: leadAgentId,
    content: 'Cancelled by founder',
    summary: 'cancel',
  });

  // Wake the lead so it processes the shutdown promptly rather than
  // waiting on the reconcile-mailbox cron tick. Idempotent within a
  // 1-second window via BullMQ jobId dedupe; failures are swallowed
  // by wake() itself, the cron is the durable backstop.
  try {
    await wake(leadAgentId);
  } catch (err) {
    // Defense in depth: even if wake() throws (it shouldn't), the
    // shutdown_request row is the durable contract — log and continue.
    log.warn(
      `wake() failed for lead=${leadAgentId} after cancel insert: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  log.info(
    `POST /api/team/run/${messageId}/cancel user=${userId} team=${teamId} ` +
      `leadAgentId=${leadAgentId} shutdown_request inserted`,
  );
  return NextResponse.json(
    { runId: messageId, status: 'cancel_requested' },
    { status: 202 },
  );
}
