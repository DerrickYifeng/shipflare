// calibrate_search_strategy — one-time discovery-strategy calibrator.
//
// Spawns the search-strategist agent against a (user, productId, platform),
// which iteratively probes the platform with batch searches, judges yield,
// and evolves queries until the winning set surfaces enough queueable
// threads. The output is persisted to MemoryStore as `${platform}-search-
// strategy` so subsequent run_discovery_scan calls can load it verbatim
// and skip the expensive query-generation step.
//
// Pipeline placement: called by the coordinator in the kickoff playbook
// the first time a (user, product, platform) needs a scan, BEFORE
// run_discovery_scan. run_discovery_scan throws STRATEGY_NOT_CALIBRATED
// when the entry is missing, prompting the coordinator to call this
// tool then retry.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { products } from '@/lib/db/schema';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import {
  searchStrategistOutputSchema,
  type SearchStrategistOutput,
} from '@/tools/AgentTool/agents/search-strategist/schema';
import { MemoryStore } from '@/memory/store';
import { createPlatformDeps } from '@/lib/platform-deps';
import { getPlatformConfig } from '@/lib/platform-config';
import { readDomainDeps } from '@/tools/context-helpers';
import { createLogger } from '@/lib/logger';
import {
  searchStrategyMemoryName,
  type PersistedSearchStrategy,
} from './strategy-memory';

const log = createLogger('tools:calibrate-search');

export const CALIBRATE_SEARCH_STRATEGY_TOOL_NAME = 'calibrate_search_strategy';

// Re-export the standalone helpers so existing imports keep working —
// see strategy-memory.ts for why these live in their own file.
export {
  searchStrategyMemoryName,
  type PersistedSearchStrategy,
} from './strategy-memory';

const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  /** Per-tweet queueable precision required to declare success.
   *  Default 0.7. Lower for hard-to-find niches; higher only if
   *  the founder explicitly wants stricter queues. */
  targetPrecision: z.number().min(0).max(1).optional(),
  /** Iteration budget. Default 60. MUST stay in sync with the
   *  search-strategist AGENT.md frontmatter `maxTurns` value or
   *  the LLM will think it has more budget than the harness allows. */
  maxTurns: z.number().int().min(20).max(120).optional(),
  /** Minimum unique tweets the strategist must judge before
   *  declaring `reachedTarget: true`. Default 20 — guards against
   *  1-of-1 = 100% false positives. */
  minSampleSize: z.number().int().min(5).max(200).optional(),
});

export interface CalibrateSearchStrategyResult {
  saved: boolean;
  /** Reason when not saved (e.g., `no_${platform}_channel`). */
  reason?: string;
  platform: 'x' | 'reddit';
  queries: string[];
  /** Present only when `saved` is true. */
  observedPrecision?: number;
  /** Present only when `saved` is true. */
  reachedTarget?: boolean;
  /** Present only when `saved` is true. */
  turnsUsed?: number;
  /** Present only when `saved` is true. */
  sampleSize?: number;
  rationale: string;
  costUsd: number;
}

function buildStrategistMessage(args: {
  platform: 'x' | 'reddit';
  sources: string[];
  product: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
  };
  targetPrecision: number;
  maxTurns: number;
  minSampleSize: number;
}): string {
  return JSON.stringify(args, null, 2);
}

export const calibrateSearchStrategyTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  CalibrateSearchStrategyResult
> = buildTool({
  name: CALIBRATE_SEARCH_STRATEGY_TOOL_NAME,
  description:
    'Run the iterative search-strategist on a platform (x | reddit) and ' +
    'persist the winning query set to MemoryStore as the cached search ' +
    'strategy. Call this BEFORE the first `run_discovery_scan` for a ' +
    '(product, platform) — subsequent scans pull queries from the saved ' +
    'strategy. Skips gracefully when no channel is connected.',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(
    input,
    ctx,
  ): Promise<CalibrateSearchStrategyResult> {
    const { userId, productId, db } = readDomainDeps(ctx);
    const { platform } = input;
    const targetPrecision = input.targetPrecision ?? 0.7;
    const maxTurns = input.maxTurns ?? 60;
    const minSampleSize = input.minSampleSize ?? 20;

    // Channel preflight — calibration without a connected channel is
    // a no-op; the strategist's tools would fail anyway.
    let deps;
    try {
      deps = await createPlatformDeps(platform, userId, productId);
    } catch {
      return {
        saved: false,
        reason: `no_${platform}_channel`,
        platform,
        queries: [],
        rationale: '',
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
    const sources = [...config.defaultSources];

    const strategistDef = await resolveAgent('search-strategist');
    if (!strategistDef) {
      throw new Error(
        'search-strategist agent definition not found in registry',
      );
    }
    const strategistConfig = buildAgentConfigFromDefinition(strategistDef);

    const strategistCtx = createToolContext({
      ...(deps as Record<string, unknown>),
      userId,
      productId,
      db,
    });

    const message = buildStrategistMessage({
      platform,
      sources,
      product: {
        name: productRow.name,
        description: productRow.description,
        valueProp: productRow.valueProp ?? null,
        keywords: productRow.keywords,
      },
      targetPrecision,
      maxTurns,
      minSampleSize,
    });

    const run = await runAgent<SearchStrategistOutput>(
      strategistConfig,
      message,
      strategistCtx,
      searchStrategistOutputSchema,
    );

    const strategy = run.result;

    const persisted: PersistedSearchStrategy = {
      ...strategy,
      platform,
      generatedAt: new Date().toISOString(),
      schemaVersion: 2,
    };

    const store = new MemoryStore(userId, productId);
    await store.saveEntry({
      name: searchStrategyMemoryName(platform),
      description:
        `Calibrated ${platform} search strategy — ${strategy.queries.length} queries, ` +
        `${(strategy.observedPrecision * 100).toFixed(0)}% precision over ` +
        `${strategy.sampleSize} judged tweets in ${strategy.turnsUsed} turn(s)` +
        `${strategy.reachedTarget ? '' : ' (best-effort, target not reached)'}`,
      type: 'reference',
      content: JSON.stringify(persisted, null, 2),
    });

    log.info(
      `calibrated ${platform} search strategy for product=${productId}: ` +
        `${strategy.queries.length} queries, precision=${strategy.observedPrecision.toFixed(2)}, ` +
        `sample=${strategy.sampleSize}, turns=${strategy.turnsUsed}, ` +
        `reached=${strategy.reachedTarget}, cost=$${run.usage.costUsd.toFixed(4)}`,
    );

    return {
      saved: true,
      platform,
      queries: strategy.queries,
      observedPrecision: strategy.observedPrecision,
      reachedTarget: strategy.reachedTarget,
      turnsUsed: strategy.turnsUsed,
      sampleSize: strategy.sampleSize,
      rationale: strategy.rationale,
      costUsd: run.usage.costUsd,
    };
  },
});
