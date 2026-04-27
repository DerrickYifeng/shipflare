// query_strategic_path — read the active strategic_paths row for the
// current (userId, productId). Zero-arg; scoped to ctx.
//
// Called by: coordinator, growth-strategist, content-planner.
// Returns: the strategicPathSchema-shaped object, or null if no row
// exists yet (onboarding hasn't run).

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { strategicPaths } from '@/lib/db/schema';
import {
  strategicPathSchema,
  type StrategicPath,
} from '@/tools/schemas';
import { readDomainDeps } from '@/tools/context-helpers';

export const QUERY_STRATEGIC_PATH_TOOL_NAME = 'query_strategic_path';

export const queryStrategicPathTool: ToolDefinition<
  Record<string, never>,
  StrategicPath | null
> = buildTool({
  name: QUERY_STRATEGIC_PATH_TOOL_NAME,
  description:
    'Return the current active strategic path (narrative, milestones, ' +
    'thesis arc, content pillars, channel mix, phase goals) for this ' +
    "product. Returns null when onboarding hasn't produced one yet.",
  inputSchema: z.object({}).strict(),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(_input, ctx): Promise<StrategicPath | null> {
    const { db, userId, productId } = readDomainDeps(ctx);

    const rows = await db
      .select({
        narrative: strategicPaths.narrative,
        milestones: strategicPaths.milestones,
        thesisArc: strategicPaths.thesisArc,
        contentPillars: strategicPaths.contentPillars,
        channelMix: strategicPaths.channelMix,
        phaseGoals: strategicPaths.phaseGoals,
      })
      .from(strategicPaths)
      .where(
        and(
          eq(strategicPaths.userId, userId),
          eq(strategicPaths.productId, productId),
          eq(strategicPaths.isActive, true),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];

    // Parse via the schema so callers get a validated shape (jsonb → object).
    // If a legacy row has missing optional fields, strategicPathSchema's
    // defaults + optionals keep the parse successful.
    const parsed = strategicPathSchema.safeParse({
      narrative: row.narrative,
      milestones: row.milestones,
      thesisArc: row.thesisArc,
      contentPillars: row.contentPillars,
      channelMix: row.channelMix,
      phaseGoals: row.phaseGoals,
    });
    if (!parsed.success) {
      // A malformed row is a data bug, not a tool-call failure — surface it
      // explicitly so the agent can escalate.
      throw new Error(
        `query_strategic_path: stored strategic_path is malformed: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  },
});
