// Snapshot shape choice: `tactical` keeps the pre-team-run fields the UI
// already binds (status, itemCount, expectedCount, error, planId). A sibling
// `teamRun: { teamId, runId } | null` carries the SSE-subscription target so
// the client doesn't need a second round-trip to /api/team/status. `planId`
// is now populated with the team-run id (reused field — UI labels remain
// neutral), so TacticalSnapshot's ergonomics stay intact.

import type { NextRequest } from 'next/server';
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  teamMessages,
  teamRuns,
  teams,
} from '@/lib/db/schema';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:progress');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type TacticalStatus = 'pending' | 'running' | 'completed' | 'failed';

interface PlatformCalibration {
  platform: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  precision: number | null;
  round: number;
}

interface TeamRunRef {
  teamId: string;
  runId: string;
}

interface ProgressSnapshot {
  tactical: {
    status: TacticalStatus;
    itemCount: number;
    expectedCount: number | null;
    error: string | null;
    planId: string | null;
  };
  teamRun: TeamRunRef | null;
  calibration: {
    platforms: PlatformCalibration[];
  };
}

const TACTICAL_TRIGGERS = [
  'onboarding',
  'weekly',
  'manual',
  'phase_transition',
] as const;

const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUCCESS_FRESH_MS = 5 * 60 * 1000;

/**
 * GET /api/today/progress
 *
 * Initial snapshot for the /today progress widget. Returns the current
 * state of the two async onboarding tails:
 *
 *   1. Team-run tactical pass — the coordinator drives `content-planner`,
 *      which calls `add_plan_item` N times. Each tool_call lands as a row
 *      in `team_messages`. Status derives from `team_runs.status` plus
 *      freshness; item count is a live COUNT on `team_messages` filtered
 *      by `metadata.toolName = 'add_plan_item'`.
 *
 *   2. `calibrate-discovery` worker — per-platform calibration status lives
 *      in `discovery_configs.calibration_status`. Unchanged.
 *
 * Clients should:
 *   - call this once on mount to seed the UI
 *   - for tactical: subscribe to /api/team/events with the returned
 *     teamRun.teamId + runId
 *   - for calibration: subscribe to /api/events?channel=agents (still
 *     publishes calibration_progress / calibration_complete)
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'x-trace-id': traceId,
      },
    });
  }
  const userId = session.user.id;

  const snapshot = await buildSnapshot(userId);

  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'x-trace-id': traceId,
    },
  });
}

async function buildSnapshot(userId: string): Promise<ProgressSnapshot> {
  const { tactical, teamRun } = await loadTacticalStatus(userId);

  // Discovery v3: no calibration state. Shape retained for client
  // back-compat — always returns an empty platforms list.
  return {
    tactical,
    teamRun,
    calibration: { platforms: [] },
  };
}

async function loadTacticalStatus(userId: string): Promise<{
  tactical: ProgressSnapshot['tactical'];
  teamRun: TeamRunRef | null;
}> {
  // Prefer the product-linked team; fall back to any team the user owns.
  // Sorting by productId-nullslast keeps deterministic selection when a
  // user (somehow) has both a product-linked and un-linked team.
  const teamRows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.userId, userId))
    .orderBy(sql`${teams.productId} IS NULL`, desc(teams.createdAt))
    .limit(1);

  if (teamRows.length === 0) {
    return {
      tactical: {
        status: 'pending',
        itemCount: 0,
        expectedCount: null,
        error: null,
        planId: null,
      },
      teamRun: null,
    };
  }
  const teamId = teamRows[0].id;

  const staleCutoff = new Date(Date.now() - STALE_WINDOW_MS);
  const [runRow] = await db
    .select({
      id: teamRuns.id,
      status: teamRuns.status,
      completedAt: teamRuns.completedAt,
      errorMessage: teamRuns.errorMessage,
    })
    .from(teamRuns)
    .where(
      and(
        eq(teamRuns.teamId, teamId),
        inArray(teamRuns.trigger, TACTICAL_TRIGGERS as unknown as string[]),
        gte(teamRuns.startedAt, staleCutoff),
      ),
    )
    .orderBy(desc(teamRuns.startedAt))
    .limit(1);

  if (!runRow) {
    return {
      tactical: {
        status: 'pending',
        itemCount: 0,
        expectedCount: null,
        error: null,
        planId: null,
      },
      teamRun: null,
    };
  }

  const itemCount = await countAddPlanItemCalls(runRow.id);

  if (runRow.status === 'running') {
    return {
      tactical: {
        status: 'running',
        itemCount,
        expectedCount: null,
        error: null,
        planId: runRow.id,
      },
      teamRun: { teamId, runId: runRow.id },
    };
  }

  if (runRow.status === 'failed') {
    return {
      tactical: {
        status: 'failed',
        itemCount,
        expectedCount: null,
        error: runRow.errorMessage ?? 'Team run failed.',
        planId: runRow.id,
      },
      teamRun: { teamId, runId: runRow.id },
    };
  }

  if (runRow.status === 'completed') {
    const completedAt = runRow.completedAt?.getTime() ?? 0;
    const fresh = completedAt > 0 && Date.now() - completedAt < SUCCESS_FRESH_MS;
    return {
      tactical: {
        status: fresh ? 'completed' : 'pending',
        itemCount,
        expectedCount: null,
        error: null,
        planId: fresh ? runRow.id : null,
      },
      teamRun: fresh ? { teamId, runId: runRow.id } : null,
    };
  }

  // cancelled / pending / unknown — treat as pending (UI hides).
  return {
    tactical: {
      status: 'pending',
      itemCount,
      expectedCount: null,
      error: null,
      planId: null,
    },
    teamRun: null,
  };
}

/**
 * Count `add_plan_item` tool_calls for a specific team_run. Counting in SQL
 * avoids shipping every message row to Node just to length-check the list.
 */
async function countAddPlanItemCalls(runId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.runId, runId),
        eq(teamMessages.type, 'tool_call'),
        sql`${teamMessages.metadata} ->> 'toolName' = 'add_plan_item'`,
      ),
    );
  return rows[0]?.n ?? 0;
}
