// run_discovery_scan — wraps the v3 discovery pipeline as a synchronous
// tool callable from a team-member agent loop (the coordinator). The
// existing BullMQ discovery-scan worker enqueued one of these per
// (user, platform); after the unified-pipeline migration the same logic
// lives here, called inline from inside a team-run.
//
// The tool reads a cached search strategy out of MemoryStore and passes
// it down as `presetQueries` when present. When the strategy is missing
// or at a legacy schemaVersion, the tool falls back to scout's inline
// query generation — the kickoff fast path relies on this so a fresh
// user gets results without waiting for the full calibration loop.

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
import { MemoryStore } from '@/memory/store';
import {
  searchStrategyMemoryName,
  type PersistedSearchStrategy,
} from '@/tools/CalibrateSearchTool/strategy-memory';

export const RUN_DISCOVERY_SCAN_TOOL_NAME = 'run_discovery_scan';

const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  /** Override default sources from platform-config; coordinator can pass
   * a narrower list (e.g. just 2 hot subreddits) for cheap onboarding scans. */
  sources: z.array(z.string().min(1)).optional(),
  /** Number of queries scout should generate when no calibrated strategy
   * exists in MemoryStore. Default (scout's): 8. Pass 12 from the kickoff
   * fast-path scan to deliberately span breadth (broad + medium + specific).
   * Ignored when a calibrated strategy is loaded. */
  inlineQueryCount: z.number().int().min(4).max(20).optional(),
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
  /**
   * Sweep-level commentary from the scout — surfaces the "I rejected all
   * 22 because they were competitor reposts" story to the coordinator,
   * which would otherwise see only `queued: []` and confabulate. Empty
   * string when the scout didn't run (skipped path).
   */
  scoutNotes: string;
  costUsd: number;
}

/** Try to parse a persisted strategy entry. Returns null when the entry
 *  is missing, malformed, or for the wrong platform. */
function loadStrategy(
  raw: string | undefined,
  platform: 'x' | 'reddit',
): PersistedSearchStrategy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSearchStrategy;
    if (parsed.schemaVersion !== 2) return null;
    if (parsed.platform !== platform) return null;
    if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const runDiscoveryScanTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  RunDiscoveryScanResult
> = buildTool({
  name: RUN_DISCOVERY_SCAN_TOOL_NAME,
  description:
    'Run discovery scout on a platform (x | reddit). When a calibrated ' +
    'search strategy exists in MemoryStore it is loaded and used verbatim; ' +
    'otherwise scout falls back to inline query generation (pass ' +
    '`inlineQueryCount` to widen breadth — kickoff uses 12). Returns ' +
    'queue-worthy threads with confidence + reason and a `scoutNotes` ' +
    'summary explaining what was filtered. Threads are persisted to the ' +
    'threads table (state=queued); dispatch community-manager against the ' +
    'returned externalIds. Returns `skipped:true, reason:"no_${platform}_channel"` ' +
    'when no channel is connected.',
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
        scoutNotes: '',
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

    // Load the cached search strategy if present. When missing or at a
    // legacy schemaVersion we run scout in inline mode (no preset
    // queries) — the kickoff fast path relies on this so a fresh user
    // gets results without waiting for the full calibration loop.
    const store = new MemoryStore(userId, productId);
    const entry = await store.loadEntry(searchStrategyMemoryName(platform));
    const strategy = loadStrategy(entry?.content, platform);

    const config = getPlatformConfig(platform);
    const sources = input.sources ?? [...config.defaultSources];

    const queryCountForLog = strategy
      ? strategy.queries.length
      : input.inlineQueryCount ?? 8;
    ctx.emitProgress?.(
      'run_discovery_scan',
      `Searching ${platform} with ${queryCountForLog} ${strategy ? 'calibrated' : 'inline'} queries`,
      { platform, queryCount: queryCountForLog, mode: strategy ? 'calibrated' : 'inline' },
    );

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
        scoutNotes: '',
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
        ...(strategy
          ? { presetQueries: strategy.queries, negativeTerms: strategy.negativeTerms }
          : { inlineQueryCount: input.inlineQueryCount }),
      },
      deps,
    );

    const queueVerdicts = result.verdicts.filter((v) => v.verdict === 'queue');
    if (queueVerdicts.length > 0) {
      await persistScoutVerdicts({ userId, verdicts: queueVerdicts, db });
    }

    ctx.emitProgress?.(
      'run_discovery_scan',
      `Scanned ${result.verdicts.length} threads · ${queueVerdicts.length} queueable`,
      {
        platform,
        scanned: result.verdicts.length,
        queued: queueVerdicts.length,
      },
    );

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
      scoutNotes: result.scoutNotes,
      costUsd,
    };
  },
});
