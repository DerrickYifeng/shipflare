// run_discovery_scan — wraps the v3 discovery pipeline as a synchronous
// tool callable from a team-member agent loop (community-scout). The
// existing BullMQ discovery-scan worker enqueued one of these per
// (user, platform); after the unified-pipeline migration the same logic
// lives here, called inline from inside a team-run.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { db } from '@/lib/db';
import { products, channels } from '@/lib/db/schema';
import { runDiscoveryV3 } from '@/lib/discovery/v3-pipeline';
import { persistScoutVerdicts } from '@/lib/discovery/persist-scout-verdicts';
import { createPlatformDeps } from '@/lib/platform-deps';
import { getPlatformConfig } from '@/lib/platform-config';
import { readDomainDeps } from '@/tools/context-helpers';

export const RUN_DISCOVERY_SCAN_TOOL_NAME = 'run_discovery_scan';

const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  /** Override default sources from platform-config; coordinator can pass
   * a narrower list (e.g. just 2 hot subreddits) for cheap onboarding scans. */
  sources: z.array(z.string().min(1)).optional(),
});

export interface QueuedThreadSummary {
  externalId: string;
  platform: 'x' | 'reddit';
  title: string;
  body: string;
  author: string;
  url: string;
  confidence: number;
  reason: string;
}

export interface RunDiscoveryScanResult {
  skipped: boolean;
  reason?: string;
  scanned: number;
  queued: QueuedThreadSummary[];
  costUsd: number;
}

export const runDiscoveryScanTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  RunDiscoveryScanResult
> = buildTool({
  name: RUN_DISCOVERY_SCAN_TOOL_NAME,
  description:
    'Run discovery scout on a platform (x | reddit). Returns the threads ' +
    'judged "queue"-worthy with their confidence + reason. The threads ' +
    'are persisted to the threads table (state=queued); reply-drafter ' +
    'should be dispatched against the returned externalIds. Skips ' +
    'gracefully when no channel for the platform is connected.',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<RunDiscoveryScanResult> {
    const { userId, productId } = readDomainDeps(ctx);
    const { platform } = input;

    // Channel preflight — no channel = no scan.
    const channelRows = await db
      .select({ platform: channels.platform })
      .from(channels)
      .where(eq(channels.userId, userId));
    const hasChannel = channelRows.some((c) => c.platform === platform);
    if (!hasChannel) {
      return {
        skipped: true,
        reason: `no_${platform}_channel`,
        scanned: 0,
        queued: [],
        costUsd: 0,
      };
    }

    const [productRow] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!productRow) {
      throw new Error(`product ${productId} not found`);
    }

    const config = getPlatformConfig(platform);
    const sources = input.sources ?? [...config.defaultSources];

    let deps;
    try {
      deps = await createPlatformDeps(platform, userId, productId);
    } catch {
      // createPlatformDeps throws when no channel — treat as skipped
      return {
        skipped: true,
        reason: `no_${platform}_channel`,
        scanned: 0,
        queued: [],
        costUsd: 0,
      };
    }

    const result = await runDiscoveryV3(
      {
        userId,
        productId,
        platform,
        sources,
        product: {
          name: productRow.name,
          description: productRow.description,
          valueProp: productRow.valueProp ?? null,
          keywords: productRow.keywords,
        },
      },
      deps,
    );

    const queueVerdicts = result.verdicts.filter((v) => v.verdict === 'queue');
    if (queueVerdicts.length > 0) {
      await persistScoutVerdicts({ userId, verdicts: queueVerdicts, db });
    }

    const queued: QueuedThreadSummary[] = queueVerdicts.map((v) => ({
      externalId: v.externalId,
      platform: v.platform as 'x' | 'reddit',
      title: v.title ?? '',
      body: v.body ?? '',
      author: v.author ?? '',
      url: v.url,
      confidence: v.confidence,
      reason: v.reason,
    }));

    const costUsd =
      (result.usage.scout.costUsd ?? 0) +
      (result.usage.reviewer?.costUsd ?? 0);

    return {
      skipped: false,
      scanned: result.verdicts.length,
      queued,
      costUsd,
    };
  },
});
