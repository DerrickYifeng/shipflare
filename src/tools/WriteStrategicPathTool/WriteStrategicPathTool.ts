// write_strategic_path — singleton INSERT or UPDATE of strategic_paths
// for the current (userId, productId).
//
// Called by: growth-strategist (Phase B agent).
// Reads: nothing. Validates input against strategicPathSchema.
// Writes: strategic_paths row — UPDATE if any row exists for
// (userId, productId), else INSERT. The uniqueIndex
// `strategic_paths_active_uq` on userId WHERE is_active enforces one
// active path per user; we side-step the edge case by UPDATING whichever
// row matches (userId, productId).

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { strategicPaths, products } from '@/lib/db/schema';
import { strategicPathSchema } from '@/tools/schemas';
import { readDomainDeps } from '@/tools/context-helpers';

export const WRITE_STRATEGIC_PATH_TOOL_NAME = 'write_strategic_path';

export interface WriteStrategicPathResult {
  pathId: string;
  persisted: 'inserted' | 'updated';
}

export const writeStrategicPathTool: ToolDefinition<
  z.infer<typeof strategicPathSchema>,
  WriteStrategicPathResult
> = buildTool({
  name: WRITE_STRATEGIC_PATH_TOOL_NAME,
  description:
    'Persist the strategic path (narrative + milestones + thesis arc + ' +
    'content pillars + channel mix + phase goals) for the current product. ' +
    'Singleton per product — overwrites an existing path; creates one ' +
    'otherwise. Call this exactly once per strategic-planning run.' +
    '\n\n' +
    'INPUT SHAPE (`milestones` and `thesisArc` MUST be arrays of objects; ' +
    '`channelMix` and `phaseGoals` MUST be objects, NOT strings):\n' +
    '{\n' +
    '  "narrative": "We are building ... (200-2400 chars)",\n' +
    '  "milestones": [\n' +
    '    { "atDayOffset": -14, "title": "Beta launch", "successMetric": "50 signups", "phase": "launch" }\n' +
    '  ],\n' +
    '  "thesisArc": [\n' +
    '    { "weekStart": "2026-04-28T00:00:00Z", "theme": "Pain-point hooks", "angleMix": ["claim", "story"] }\n' +
    '  ],\n' +
    '  "contentPillars": ["CI pain", "cost savings", "indie founder life"],\n' +
    '  "channelMix": {\n' +
    '    "x": { "perWeek": 5, "repliesPerDay": 3, "preferredHours": [9, 14, 18] },\n' +
    '    "reddit": null\n' +
    '  },\n' +
    '  "phaseGoals": {\n' +
    '    "foundation": "Set up profile + first 10 posts",\n' +
    '    "audience": null\n' +
    '  }\n' +
    '}',
  inputSchema: strategicPathSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<WriteStrategicPathResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    // Look up the product to snapshot phase / launchDate at write time.
    // strategic_paths.phase is notNull; we derive it from products.state
    // mirroring the behavior of /api/onboarding/commit + re-plan.
    const productRows = await db
      .select({
        state: products.state,
        launchDate: products.launchDate,
        launchedAt: products.launchedAt,
      })
      .from(products)
      .where(and(eq(products.id, productId), eq(products.userId, userId)))
      .limit(1);
    const product = productRows[0];
    if (!product) {
      throw new Error(
        `write_strategic_path: product ${productId} not found for user ${userId}`,
      );
    }

    const { derivePhase } = await import('@/lib/launch-phase');
    const phase = derivePhase({
      state: product.state as Parameters<typeof derivePhase>[0]['state'],
      launchDate: product.launchDate ?? null,
      launchedAt: product.launchedAt ?? null,
    });

    // Find an existing path for (userId, productId). We prefer updating
    // whatever row is there to preserve downstream references (plans row's
    // strategicPathId FK). If there's no row, insert a fresh one.
    const existing = await db
      .select({ id: strategicPaths.id })
      .from(strategicPaths)
      .where(
        and(
          eq(strategicPaths.userId, userId),
          eq(strategicPaths.productId, productId),
          eq(strategicPaths.isActive, true),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const pathId = existing[0].id;
      await db
        .update(strategicPaths)
        .set({
          phase,
          launchDate: product.launchDate ?? null,
          launchedAt: product.launchedAt ?? null,
          narrative: input.narrative,
          milestones: input.milestones,
          thesisArc: input.thesisArc,
          contentPillars: input.contentPillars,
          channelMix: input.channelMix,
          phaseGoals: input.phaseGoals,
          generatedAt: new Date(),
        })
        .where(eq(strategicPaths.id, pathId));
      return { pathId, persisted: 'updated' };
    }

    const pathId = crypto.randomUUID();
    await db.insert(strategicPaths).values({
      id: pathId,
      userId,
      productId,
      isActive: true,
      phase,
      launchDate: product.launchDate ?? null,
      launchedAt: product.launchedAt ?? null,
      narrative: input.narrative,
      milestones: input.milestones,
      thesisArc: input.thesisArc,
      contentPillars: input.contentPillars,
      channelMix: input.channelMix,
      phaseGoals: input.phaseGoals,
    });
    return { pathId, persisted: 'inserted' };
  },
});
