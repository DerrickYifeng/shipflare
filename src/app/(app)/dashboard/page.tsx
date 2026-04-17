import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { pipelineEvents } from '@/lib/db/schema';
import { and, eq, gte, sql } from 'drizzle-orm';
import { HeaderBar } from '@/components/layout/header-bar';
import { PipelineFunnel } from '@/components/dashboard/pipeline-funnel';

export const metadata: Metadata = { title: 'Metrics' };

// Ordered funnel stages. Transitions in this order drive the stage-to-stage
// latency table: discovered → gate_passed → draft_created → reviewed →
// approved → posted. `engaged` and `failed` are side-channel stages not
// shown in the happy-path funnel.
const FUNNEL_STAGES = [
  'discovered',
  'gate_passed',
  'draft_created',
  'reviewed',
  'approved',
  'posted',
] as const;

type FunnelStage = (typeof FUNNEL_STAGES)[number];

interface StageRow {
  stage: string;
  count: number;
}

interface LatencyRow {
  stage: FunnelStage;
  p50Ms: number;
  p95Ms: number;
  samples: number;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Per-stage event counts in the last 7 days.
  const stageRows: StageRow[] = await db
    .select({
      stage: pipelineEvents.stage,
      count: sql<number>`count(*)::int`,
    })
    .from(pipelineEvents)
    .where(
      and(
        eq(pipelineEvents.userId, session.user.id),
        gte(pipelineEvents.enteredAt, sevenDaysAgo),
      ),
    )
    .groupBy(pipelineEvents.stage);

  const countByStage = new Map(stageRows.map((r) => [r.stage, r.count]));

  // Per-stage p50/p95 durationMs. `durationMs` is only populated on
  // draft_created today (time since the 'discovered' event for the same
  // thread) — other stages will show 0 samples until further
  // instrumentation. Using percentile_cont for smooth p50/p95.
  const latencyRows = await db
    .select({
      stage: pipelineEvents.stage,
      p50Ms: sql<number>`coalesce(percentile_cont(0.5) within group (order by duration_ms)::int, 0)`,
      p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by duration_ms)::int, 0)`,
      samples: sql<number>`count(duration_ms)::int`,
    })
    .from(pipelineEvents)
    .where(
      and(
        eq(pipelineEvents.userId, session.user.id),
        gte(pipelineEvents.enteredAt, sevenDaysAgo),
        sql`duration_ms is not null`,
      ),
    )
    .groupBy(pipelineEvents.stage);

  const latencyByStage = new Map(
    latencyRows
      .filter((r): r is typeof r & { stage: FunnelStage } =>
        (FUNNEL_STAGES as readonly string[]).includes(r.stage),
      )
      .map((r) => [r.stage, r]),
  );

  const funnel = FUNNEL_STAGES.map((stage) => ({
    stage,
    count: countByStage.get(stage) ?? 0,
  }));
  const discoveredCount = funnel[0].count;

  const latencyTable: LatencyRow[] = FUNNEL_STAGES.map((stage) => {
    const row = latencyByStage.get(stage);
    return {
      stage,
      p50Ms: row?.p50Ms ?? 0,
      p95Ms: row?.p95Ms ?? 0,
      samples: row?.samples ?? 0,
    };
  });

  const failedCount = countByStage.get('failed') ?? 0;
  const engagedCount = countByStage.get('engaged') ?? 0;

  return (
    <>
      <HeaderBar title="Metrics" healthScore={null} />
      <div className="flex-1 overflow-y-auto p-6">
        <PipelineFunnel
          funnel={funnel}
          discoveredCount={discoveredCount}
          latencyTable={latencyTable}
          failedCount={failedCount}
          engagedCount={engagedCount}
        />
      </div>
    </>
  );
}
