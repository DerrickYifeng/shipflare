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
  /** Override defaults — caller can dial cost vs. quality. */
  targetYield: z.number().min(0).max(1).optional(),
  queriesPerRound: z.number().int().min(1).max(8).optional(),
  maxRounds: z.number().int().min(1).max(5).optional(),
});

export interface CalibrateSearchStrategyResult {
  saved: boolean;
  /** Reason when not saved (e.g., `no_${platform}_channel`). */
  reason?: string;
  platform: 'x' | 'reddit';
  queries: string[];
  observedYield: number;
  roundsUsed: number;
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
  targetYield: number;
  queriesPerRound: number;
  maxRounds: number;
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
    const targetYield = input.targetYield ?? 0.5;
    const queriesPerRound = input.queriesPerRound ?? 4;
    const maxRounds = input.maxRounds ?? 3;

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
        observedYield: 0,
        roundsUsed: 0,
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
      targetYield,
      queriesPerRound,
      maxRounds,
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
      schemaVersion: 1,
    };

    const store = new MemoryStore(userId, productId);
    await store.saveEntry({
      name: searchStrategyMemoryName(platform),
      description:
        `Calibrated ${platform} search strategy — ${strategy.queries.length} queries, ` +
        `${(strategy.observedYield * 100).toFixed(0)}% yield in ${strategy.roundsUsed} round(s)`,
      type: 'reference',
      content: JSON.stringify(persisted, null, 2),
    });

    log.info(
      `calibrated ${platform} search strategy for product=${productId}: ` +
        `${strategy.queries.length} queries, yield=${strategy.observedYield.toFixed(2)}, ` +
        `rounds=${strategy.roundsUsed}, cost=$${run.usage.costUsd.toFixed(4)}`,
    );

    return {
      saved: true,
      platform,
      queries: strategy.queries,
      observedYield: strategy.observedYield,
      roundsUsed: strategy.roundsUsed,
      rationale: strategy.rationale,
      costUsd: run.usage.costUsd,
    };
  },
});
