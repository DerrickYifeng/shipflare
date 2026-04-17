/**
 * Standalone discovery eval script.
 *
 * Runs the real discovery pipeline (same as production) and outputs results
 * for Claude Code to evaluate and optimize.
 *
 * Usage:
 *   bun src/scripts/discovery-eval.ts                          # human-readable, reddit
 *   bun src/scripts/discovery-eval.ts --json                   # JSON output, reddit
 *   bun src/scripts/discovery-eval.ts --json --platform x      # JSON output, X/Twitter
 *   bun src/scripts/discovery-eval.ts --source SideProject     # single source
 *   bun src/scripts/discovery-eval.ts --product-id abc123      # specific product
 */

import 'dotenv/config';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { createPlatformDeps } from '@/lib/platform-deps';
import { getPlatformConfig } from '@/lib/platform-config';
import { join } from 'path';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface Flags {
  json: boolean;
  platform: string;
  source: string | null;
  productId: string | null;
}

function parseFlags(): Flags {
  const args = process.argv.slice(2);
  const flags: Flags = { json: false, platform: 'reddit', source: null, productId: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--json':
        flags.json = true;
        break;
      case '--platform':
        flags.platform = args[++i] ?? 'reddit';
        break;
      case '--source':
        flags.source = args[++i] ?? null;
        break;
      case '--product-id':
        flags.productId = args[++i] ?? null;
        break;
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseFlags();

  // 1. Load product from DB
  const query = flags.productId
    ? db.select().from(products).where(eq(products.id, flags.productId)).limit(1)
    : db.select().from(products).limit(1);

  const [product] = await query;
  if (!product) {
    console.error('No product found. Run onboarding first.');
    process.exit(1);
  }

  // 2. Setup
  const skill = loadSkill(join(process.cwd(), 'src/skills/discovery'));
  const config = getPlatformConfig(flags.platform);
  const sources = flags.source ? [flags.source] : config.defaultSources;

  let deps: Record<string, unknown>;
  try {
    deps = await createPlatformDeps(flags.platform, product.userId);
  } catch {
    // Fallback: create clients without requiring a connected channel
    if (flags.platform === 'x') {
      const { XAIClient } = await import('@/lib/xai-client');
      deps = { xaiClient: new XAIClient() };
    } else if (flags.platform === 'reddit') {
      const { RedditClient } = await import('@/lib/reddit-client');
      deps = { redditClient: RedditClient.appOnly() };
    } else {
      throw new Error(`No ${flags.platform} channel connected for user ${product.userId}`);
    }
  }

  if (!flags.json) {
    console.log('Discovery Eval');
    console.log(`Product: ${product.name}`);
    console.log(`Platform: ${flags.platform}`);
    console.log(`Sources: ${sources.join(', ')}`);
    console.log();
  }

  // 3. Run discovery (loop over single-source skill — one runSkill per source)
  const start = performance.now();

  const allThreads: DiscoveryOutput['threads'] = [];
  let totalCostUsd = 0;
  const allErrors: Array<{ label: string; error: string }> = [];

  for (const source of sources) {
    const res = await runSkill<DiscoveryOutput>({
      skill,
      input: {
        productName: product.name,
        productDescription: product.description,
        keywords: product.keywords,
        valueProp: product.valueProp ?? '',
        source,
        platform: flags.platform,
      },
      deps,
      outputSchema: discoveryOutputSchema,
    });
    totalCostUsd += res.usage.costUsd;
    for (const r of res.results) allThreads.push(...r.threads);
    for (const err of res.errors) allErrors.push({ label: err.label, error: err.error });
  }

  const elapsedSec = ((performance.now() - start) / 1000).toFixed(1);
  const sorted = [...allThreads].sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));

  // 4. Output
  if (flags.json) {
    console.log(JSON.stringify({
      product: {
        name: product.name,
        description: product.description,
        valueProp: product.valueProp,
        keywords: product.keywords,
      },
      platform: flags.platform,
      sources,
      threads: sorted.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        community: t.community,
        relevanceScore: t.relevanceScore ?? 0,
        scores: t.scores ?? null,
        reason: t.reason ?? '',
      })),
      summary: {
        totalThreads: sorted.length,
        above70: sorted.filter((t) => (t.relevanceScore ?? 0) >= 70).length,
        above50: sorted.filter((t) => (t.relevanceScore ?? 0) >= 50).length,
        elapsedSec: parseFloat(elapsedSec),
        costUsd: totalCostUsd,
      },
      errors: allErrors,
    }, null, 2));
  } else {
    console.log(`Time: ${elapsedSec}s | Cost: $${totalCostUsd.toFixed(4)} | Threads: ${sorted.length}`);
    console.log(`Above 70: ${sorted.filter((t) => (t.relevanceScore ?? 0) >= 70).length} | Above 50: ${sorted.filter((t) => (t.relevanceScore ?? 0) >= 50).length}`);

    for (const err of allErrors) {
      console.log(`  ERROR [${err.label}]: ${err.error}`);
    }

    console.log();

    for (const thread of sorted.slice(0, 15)) {
      const score = thread.relevanceScore ?? 0;
      const dims = thread.scores
        ? `R=${thread.scores.relevance} I=${thread.scores.intent} E=${thread.scores.exposure ?? '-'} F=${thread.scores.freshness ?? '-'} G=${thread.scores.engagement ?? '-'}`
        : '';
      console.log(`  [${score}] ${thread.title.slice(0, 90)}`);
      console.log(`    ${thread.community} | ${thread.url}`);
      if (dims) console.log(`    ${dims}`);
      if (thread.reason) console.log(`    ${thread.reason}`);
      console.log();
    }
  }

  // Ensure process exits (DB connection may keep it alive)
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
