import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamConversations, products } from '@/lib/db/schema';
import { enqueueTeamRun, type TeamRunTrigger } from '@/lib/queue/team-run';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:run');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  teamId: z.string().min(1),
  /**
   * Human-readable goal. The UI's "+ New session" button POSTs `goal: ''`
   * so the route can derive a neutral template via `deriveGoalFromTrigger`
   * (see logic below). Empty / absent is accepted and handled by the
   * fallback path.
   */
  goal: z.string().max(4000).optional(),
  trigger: z
    .enum(['daily', 'onboarding', 'weekly', 'phase_transition'])
    .optional(),
  /**
   * Extra context for triggers whose goal template needs it beyond the
   * product row alone. Today only `phase_transition` uses the `oldPhase`
   * field; other triggers ignore the bag.
   */
  context: z
    .object({
      oldPhase: z.string().optional(),
      newPhase: z.string().optional(),
    })
    .optional(),
  /**
   * Optional explicit root-agent member id. When absent, the route resolves
   * the team's coordinator member (agent_type='coordinator') — the typical
   * entry point per spec §4.1 request flow.
   */
  rootMemberId: z.string().optional(),
  /**
   * Chat refactor: runs live inside a conversation. Callers MUST
   * supply this. The only path that creates runs without an explicit
   * conversation is `POST /api/team/conversations` (which mints the
   * conversation first and then sends the message via
   * `/conversations/:id/messages`) — routed through a different
   * endpoint, so this requirement is safe here.
   *
   * If the caller has no conversation yet (e.g. cron), they should
   * create one first via `POST /api/team/conversations` and pass its
   * id here.
   */
  conversationId: z.string().min(1),
});

/**
 * Build the per-trigger goal template enumerated in spec §4.2. Callers
 * that want to hand-craft the goal can still pass `goal` in the request
 * body and we use it verbatim.
 */
export function deriveGoalFromTrigger(
  trigger: TeamRunTrigger,
  product: {
    name: string;
    state: string;
  } | null,
  channels: string[],
  extra: { oldPhase?: string; newPhase?: string } | undefined,
): string {
  const productName = product?.name ?? 'this product';
  const state = product?.state ?? 'mvp';
  const channelList = channels.length > 0 ? channels.join(', ') : 'none';
  switch (trigger) {
    case 'onboarding':
      return `Plan the launch strategy for ${productName}. State: ${state}. Channels: ${channelList}.`;
    case 'weekly':
      return `Plan this week for ${productName}. Current state: ${state}. Carry over stalled items.`;
    case 'phase_transition':
      return `Phase changed from ${extra?.oldPhase ?? '(unknown)'} to ${extra?.newPhase ?? state}. Review and update the strategic path for ${productName}.`;
    case 'daily':
    default:
      // Daily / no-trigger fall through to the canonical daily-run goal.
      return (
        `Daily automation run for ${productName}. ` +
        `Connected platforms: ${channelList}. ` +
        `Trigger: daily. Source: manual. ` +
        `Follow your daily playbook: load today's content_reply plan_items ` +
        `and run the per-slot discovery → community-manager loop, falling ` +
        `back to default top-3 drafting if no slots exist.`
      );
  }
}

/**
 * POST /api/team/run
 *
 * Body: { teamId, goal, trigger?, rootMemberId? }
 * Auth: session user must own the team.
 * Effect: creates a team_runs row (pending) + enqueues the BullMQ job.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'parse error' },
      { status: 400 },
    );
  }

  const teamRow = await db
    .select({
      id: teams.id,
      userId: teams.userId,
      productId: teams.productId,
    })
    .from(teams)
    .where(eq(teams.id, body.teamId))
    .limit(1);

  if (teamRow.length === 0) {
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }
  if (teamRow[0].userId !== userId) {
    // Don't leak existence — return 404 to the non-owner.
    return NextResponse.json({ error: 'team_not_found' }, { status: 404 });
  }

  const trigger: TeamRunTrigger = body.trigger ?? 'daily';

  // Derive a goal when the caller didn't supply one. `deriveGoalFromTrigger`
  // covers all triggers; the UI's "+ New session" button can POST
  // `{trigger:'daily', goal:''}` without 400-ing.
  let goal = body.goal ?? '';
  if (goal === '') {
    const productRows = teamRow[0].productId
      ? await db
          .select({ name: products.name, state: products.state })
          .from(products)
          .where(eq(products.id, teamRow[0].productId))
          .limit(1)
      : [];
    const productRow = productRows[0] ?? null;
    // Channel list deferred — the scheduler will query from connected
    // channels in future triggers. For onboarding the caller typically
    // passes its own goal anyway.
    goal = deriveGoalFromTrigger(trigger, productRow, [], body.context);
  }

  // Resolve the root agent. Explicit rootMemberId wins; otherwise prefer
  // the coordinator. Fall back to an arbitrary member (typically unused,
  // but avoids a 500 in dev teams with a non-standard composition).
  let rootMemberId: string | null = null;
  if (body.rootMemberId) {
    const r = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.id, body.rootMemberId),
          eq(teamMembers.teamId, body.teamId),
        ),
      )
      .limit(1);
    if (r.length === 0) {
      return NextResponse.json({ error: 'root_member_not_found' }, { status: 400 });
    }
    rootMemberId = r[0].id;
  } else {
    const coordinators = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, body.teamId),
          eq(teamMembers.agentType, 'coordinator'),
        ),
      )
      .limit(1);
    if (coordinators.length === 0) {
      // Fall back to any member.
      const any = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, body.teamId))
        .limit(1);
      if (any.length === 0) {
        return NextResponse.json(
          { error: 'team_has_no_members' },
          { status: 400 },
        );
      }
      rootMemberId = any[0].id;
    } else {
      rootMemberId = coordinators[0].id;
    }
  }

  // Chat refactor: the conversation MUST be supplied by the caller.
  // Validate it exists + belongs to this team before enqueueing.
  const [conv] = await db
    .select({ id: teamConversations.id })
    .from(teamConversations)
    .where(
      and(
        eq(teamConversations.id, body.conversationId),
        eq(teamConversations.teamId, body.teamId),
      ),
    )
    .limit(1);
  if (!conv) {
    return NextResponse.json(
      { error: 'conversation_not_found' },
      { status: 404 },
    );
  }

  const { runId, traceId, alreadyRunning } = await enqueueTeamRun({
    teamId: body.teamId,
    goal,
    trigger,
    rootMemberId,
    conversationId: body.conversationId,
  });

  log.info(
    `POST /api/team/run user=${userId} team=${body.teamId} runId=${runId} already=${alreadyRunning}`,
  );

  return NextResponse.json(
    { runId, traceId, alreadyRunning, conversationId: body.conversationId },
    { status: alreadyRunning ? 200 : 202 },
  );
}
