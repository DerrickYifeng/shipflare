import type { NextRequest } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  plans,
  planItems,
  discoveryConfigs,
  products,
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

interface ProgressSnapshot {
  tactical: {
    status: TacticalStatus;
    itemCount: number;
    expectedCount: number | null;
    error: string | null;
    planId: string | null;
  };
  calibration: {
    platforms: PlatformCalibration[];
  };
}

/**
 * GET /api/today/progress
 *
 * Initial snapshot for the /today progress widget. Returns the current
 * state of the two async onboarding tails:
 *
 *   1. `tactical-generate` worker — writes plan_items into the pre-existing
 *      plans row created by /api/onboarding/commit. Status is derived:
 *        - items > 0         → 'completed'
 *        - notes contains "failed" → 'failed'
 *        - otherwise         → 'running' (worker is mid-flight or queued)
 *
 *   2. `calibrate-discovery` worker — per-platform calibration status lives
 *      in discovery_configs.calibration_status. We return every row for the
 *      user so the widget can render one chip per platform.
 *
 * Clients should:
 *   - call this once on mount to seed the UI
 *   - subscribe to `/api/events?channel=agents` for live updates
 *     (`tactical_generate_*` and `calibration_*` pub/sub events).
 *
 * This is NOT an SSE endpoint — the live stream already exists on
 * `/api/events`. Building a parallel SSE relay here would duplicate the
 * Redis subscriber logic for no benefit.
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
  const tactical = await loadTacticalStatus(userId);
  const calibrationRows = await db
    .select({
      platform: discoveryConfigs.platform,
      calibrationStatus: discoveryConfigs.calibrationStatus,
      calibrationRound: discoveryConfigs.calibrationRound,
      calibrationPrecision: discoveryConfigs.calibrationPrecision,
    })
    .from(discoveryConfigs)
    .where(eq(discoveryConfigs.userId, userId));

  return {
    tactical,
    calibration: {
      platforms: calibrationRows.map((r) => ({
        platform: r.platform,
        status: r.calibrationStatus,
        precision: r.calibrationPrecision ?? null,
        round: r.calibrationRound ?? 0,
      })),
    },
  };
}

/**
 * Derive tactical status from the newest plans row + its plan_items
 * count. The tactical-generate worker writes plan_items against this
 * row; the commit route creates the header with no items so the UI's
 * pending window is `items.length === 0 && notes === null`.
 */
async function loadTacticalStatus(
  userId: string,
): Promise<ProgressSnapshot['tactical']> {
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!productRow) {
    return {
      status: 'pending',
      itemCount: 0,
      expectedCount: null,
      error: null,
      planId: null,
    };
  }

  const [planRow] = await db
    .select({
      id: plans.id,
      trigger: plans.trigger,
      notes: plans.notes,
    })
    .from(plans)
    .where(
      and(eq(plans.userId, userId), eq(plans.productId, productRow.id)),
    )
    .orderBy(desc(plans.generatedAt))
    .limit(1);

  if (!planRow) {
    return {
      status: 'pending',
      itemCount: 0,
      expectedCount: null,
      error: null,
      planId: null,
    };
  }

  const itemRows = await db
    .select({ id: planItems.id })
    .from(planItems)
    .where(eq(planItems.planId, planRow.id));
  const itemCount = itemRows.length;

  // The tactical-generate processor stamps `notes` with a
  // `tactical-generate failed` message on final attempt failure. That
  // string is the /today error surface — frontend renders it verbatim.
  const isFailureNote =
    typeof planRow.notes === 'string' &&
    planRow.notes.startsWith('tactical-generate failed');

  if (isFailureNote) {
    return {
      status: 'failed',
      itemCount,
      expectedCount: null,
      error: planRow.notes,
      planId: planRow.id,
    };
  }

  if (itemCount > 0) {
    return {
      status: 'completed',
      itemCount,
      expectedCount: null,
      error: null,
      planId: planRow.id,
    };
  }

  // Header exists, zero items, no failure note — the worker is mid-flight
  // or still queued. The distinction between 'pending' and 'running'
  // isn't observable from DB state alone (we'd need to peek the BullMQ
  // job), so report 'running' uniformly. The live SSE stream flips
  // the UI to 'completed' the moment the worker publishes its event,
  // which is faster than polling this endpoint anyway.
  return {
    status: 'running',
    itemCount,
    expectedCount: null,
    error: null,
    planId: planRow.id,
  };
}
