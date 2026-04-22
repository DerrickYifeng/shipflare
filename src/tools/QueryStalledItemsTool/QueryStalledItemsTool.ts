// query_stalled_items — list plan_items whose scheduledAt has passed but
// whose state is still 'planned' or 'drafted'. Maps to the content-planner's
// "stalled work" signal — items the founder slipped past without action.
//
// Returns structured rows with a derived `stalledReason`:
//   'overdue_unplanned' — scheduledAt < now AND state = 'planned'
//   'overdue_drafted'   — scheduledAt < now AND state = 'drafted'
//
// NOTE: The stale-sweeper cron marks rows `stale` after 24h past scheduledAt
// (see src/workers/processors/stale-sweeper.ts). This tool returns items in
// the 0-24h window — still actionable, not yet swept. Once swept they move
// to state='stale' and no longer qualify.

import { z } from 'zod';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const QUERY_STALLED_ITEMS_TOOL_NAME = 'query_stalled_items';

export interface StalledItemRow {
  id: string;
  title: string;
  scheduledAt: string;
  stalledReason: 'overdue_unplanned' | 'overdue_drafted';
}

export const queryStalledItemsTool: ToolDefinition<
  Record<string, never>,
  StalledItemRow[]
> = buildTool({
  name: QUERY_STALLED_ITEMS_TOOL_NAME,
  description:
    'List plan_items whose scheduledAt has passed but are still in a ' +
    'pre-execution state (planned or drafted). Use this to surface work ' +
    'the founder missed and decide whether to reschedule, supersede, or ' +
    'drop.',
  inputSchema: z.object({}).strict(),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(_input, ctx): Promise<StalledItemRow[]> {
    const { db, userId, productId } = readDomainDeps(ctx);
    const now = new Date();

    const rows = await db
      .select({
        id: planItems.id,
        title: planItems.title,
        scheduledAt: planItems.scheduledAt,
        state: planItems.state,
      })
      .from(planItems)
      .where(
        and(
          eq(planItems.userId, userId),
          eq(planItems.productId, productId),
          lt(planItems.scheduledAt, now),
          inArray(planItems.state, ['planned', 'drafted'] as never[]),
        ),
      )
      .limit(200);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      scheduledAt:
        r.scheduledAt instanceof Date
          ? r.scheduledAt.toISOString()
          : String(r.scheduledAt),
      stalledReason:
        r.state === 'drafted' ? 'overdue_drafted' : 'overdue_unplanned',
    }));
  },
});
