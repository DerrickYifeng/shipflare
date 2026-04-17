/**
 * Standalone test script for X/Twitter discovery pipeline.
 *
 * Tests 3 layers:
 *   1. Raw XAI client (searchTweets)
 *   2. x_search tool via tool context
 *   3. Full discovery agent pipeline (single source)
 *
 * Usage:
 *   bun src/scripts/test-x-discovery.ts [level]
 *   level: 1 = client only, 2 = tool, 3 = full agent, all = all levels (default)
 */

import 'dotenv/config';
import { XAIClient } from '@/lib/xai-client';
import { xSearchTool } from '@/tools/x-search';
import { createToolContext } from '@/core/query-loop';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_QUERY = 'best SaaS tool for indie hackers 2025';
const TEST_TOPIC = 'SaaS';
const TEST_PRODUCT = {
  productName: 'ShipFlare',
  productDescription:
    'AI-powered social media growth platform that discovers relevant conversations and drafts authentic replies for indie hackers and SaaS founders.',
  keywords: ['social media automation', 'reddit marketing', 'content discovery', 'indie hacker tools'],
  valueProp: 'Find and engage in conversations where your product is the natural answer',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(label: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(60)}\n`);
}

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Level 1: Raw XAI Client
// ---------------------------------------------------------------------------

async function testLevel1() {
  hr('Level 1: Raw XAI Client (searchTweets)');

  const client = new XAIClient();
  const start = performance.now();

  console.log(`Query: "${TEST_QUERY}"`);
  console.log('Max results: 5\n');

  try {
    const result = await client.searchTweets(TEST_QUERY, { maxResults: 5 });

    console.log(`Tweets found: ${result.tweets.length}`);
    console.log(`Search calls: ${result.searchCalls}`);
    console.log(`Time: ${elapsed(start)}\n`);

    if (result.tweets.length === 0) {
      console.log('WARNING: No tweets returned. Raw text:');
      console.log(result.rawText || '(empty)');
    } else {
      for (const tweet of result.tweets) {
        console.log(`  @${tweet.authorUsername} [${tweet.tweetId}]`);
        console.log(`    ${tweet.url}`);
        console.log(`    ${tweet.text.slice(0, 120)}${tweet.text.length > 120 ? '...' : ''}`);
        console.log();
      }
    }

    return { success: true, count: result.tweets.length };
  } catch (err) {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    return { success: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Level 2: x_search Tool
// ---------------------------------------------------------------------------

async function testLevel2() {
  hr('Level 2: x_search Tool');

  const client = new XAIClient();
  const context = createToolContext({ xaiClient: client });
  const start = performance.now();

  console.log(`Query: "${TEST_QUERY}"`);
  console.log('Max results: 5\n');

  try {
    const result = await xSearchTool.execute(
      { query: TEST_QUERY, maxResults: 5 },
      context,
    );

    const tweets = result as Array<{ id: string; url: string; author: string; text: string }>;

    console.log(`Tweets found: ${tweets.length}`);
    console.log(`Time: ${elapsed(start)}\n`);

    for (const tweet of tweets) {
      console.log(`  @${tweet.author} [${tweet.id}]`);
      console.log(`    ${tweet.url}`);
      console.log(`    ${tweet.text.slice(0, 120)}${tweet.text.length > 120 ? '...' : ''}`);
      console.log();
    }

    return { success: true, count: tweets.length };
  } catch (err) {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    return { success: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Level 3: Full Discovery Agent
// ---------------------------------------------------------------------------

async function testLevel3() {
  hr('Level 3: Full Discovery Agent (single source)');

  const start = performance.now();
  const discoverySkill = loadSkill(join(process.cwd(), 'src/skills/discovery'));

  console.log(`Platform: x`);
  console.log(`Source: "${TEST_TOPIC}"`);
  console.log(`Product: ${TEST_PRODUCT.productName}\n`);

  try {
    // Single-source discovery: loop over sources (here just one topic).
    const sources = [TEST_TOPIC];
    const allThreads: DiscoveryOutput['threads'] = [];
    const allErrors: Array<{ label: string; error: string }> = [];
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;

    for (const source of sources) {
      const res = await runSkill<DiscoveryOutput>({
        skill: discoverySkill,
        input: {
          ...TEST_PRODUCT,
          source,
          platform: 'x',
        },
        deps: { xaiClient: new XAIClient() },
        outputSchema: discoveryOutputSchema,
        onProgress: (event) => {
          if ('type' in event) {
            const e = event as Record<string, unknown>;
            if (e.type === 'tool_start') {
              console.log(`  [tool] ${e.toolName}${e.community ? ` (${e.community})` : ''}`);
            }
          }
        },
      });
      totalCostUsd += res.usage.costUsd;
      totalInputTokens += res.usage.inputTokens;
      totalOutputTokens += res.usage.outputTokens;
      totalCacheReadTokens += res.usage.cacheReadTokens;
      for (const r of res.results) allThreads.push(...r.threads);
      for (const err of res.errors) allErrors.push({ label: err.label, error: err.error });
    }

    console.log(`\nTime: ${elapsed(start)}`);
    console.log(`Cost: $${totalCostUsd.toFixed(4)}`);
    console.log(`Tokens: in=${totalInputTokens} out=${totalOutputTokens} cache_read=${totalCacheReadTokens}`);
    console.log(`Errors: ${allErrors.length}`);

    for (const err of allErrors) {
      console.log(`  ERROR [${err.label}]: ${err.error}`);
    }

    console.log(`\nThreads found: ${allThreads.length}\n`);

    const sorted = [...allThreads].sort(
      (a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0),
    );

    for (const thread of sorted.slice(0, 10)) {
      const score = thread.relevanceScore ?? 0;
      const scoreDims = thread.scores
        ? `R=${thread.scores.relevance} I=${thread.scores.intent} E=${thread.scores.exposure} F=${thread.scores.freshness} G=${thread.scores.engagement}`
        : 'no dims';
      console.log(`  [${score}] ${thread.title.slice(0, 80)}`);
      console.log(`    ${thread.url}`);
      console.log(`    ${scoreDims}`);
      console.log(`    ${thread.reason}`);
      console.log();
    }

    return { success: true, count: allThreads.length };
  } catch (err) {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return { success: false, error: err };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const level = process.argv[2] ?? 'all';

  console.log('X/Twitter Discovery Test');
  console.log(`XAI_API_KEY: ${process.env.XAI_API_KEY ? '***set***' : 'MISSING'}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '***set***' : 'MISSING'}`);

  const results: Record<string, { success: boolean; count?: number }> = {};

  if (level === '1' || level === 'all') {
    results.level1 = await testLevel1();
  }
  if (level === '2' || level === 'all') {
    results.level2 = await testLevel2();
  }
  if (level === '3' || level === 'all') {
    results.level3 = await testLevel3();
  }

  hr('Summary');
  for (const [name, r] of Object.entries(results)) {
    const status = r.success ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${name}  (${r.count ?? 0} results)`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
