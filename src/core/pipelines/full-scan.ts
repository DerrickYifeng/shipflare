import { scrapeUrl, analyzeProduct } from '@/tools/url-scraper';
import { RedditClient } from '@/lib/reddit-client';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import {
  discoveryOutputSchema,
  communityDiscoveryOutputSchema,
  communityIntelOutputSchema,
} from '@/agents/schemas';
import type {
  DiscoveryOutput,
  CommunityDiscoveryOutput,
  CommunityIntelOutput,
} from '@/agents/schemas';
import { createLogger } from '@/lib/logger';
import { join } from 'path';

const log = createLogger('pipeline:full-scan');

const SKILLS_DIR = join(process.cwd(), 'src', 'skills');
const MAX_SCAN_SUBREDDITS = 3;
const FALLBACK_SUBREDDITS = ['SideProject', 'startups', 'webdev'];

export interface FullScanResult {
  product: { name: string; description: string; url: string };
  communities: Array<{
    name: string;
    subscribers?: number;
    audienceFit: number;
    reason: string;
  }>;
  communityIntel: CommunityIntelOutput[];
  results: Array<Record<string, unknown>>;
}

export interface FullScanProgress {
  (event: string, data: unknown): void;
}

/**
 * Run a complete scan pipeline:
 * 1. Scrape URL + analyze product
 * 2. Community discovery (scout agent)
 * 3. Community intelligence (rules + hot posts)
 * 4. Thread discovery (fan-out across communities)
 * 5. Merge, dedup, sort
 */
export async function runFullScan(input: {
  url: string;
  redditClient?: RedditClient;
  onProgress?: FullScanProgress;
}): Promise<FullScanResult> {
  const { url, onProgress } = input;
  const send = onProgress ?? (() => {});
  const redditClient = input.redditClient ?? RedditClient.appOnly();

  // Step 1: Scrape + analyze
  const scraped = await scrapeUrl(url);
  const product = await analyzeProduct(scraped, url);

  send('scrape_done', {
    productName: product.productName,
    oneLiner: product.oneLiner,
    targetAudience: product.targetAudience,
    keywords: product.keywords,
  });

  const productContext = {
    productName: product.productName,
    productDescription: product.oneLiner,
    keywords: product.keywords,
    valueProp: product.valueProp,
  };

  // Step 2: Community discovery
  send('community_discovery_start', {});

  let subreddits: string[];
  let discoveredCommunities: FullScanResult['communities'] = [];

  try {
    const communitySkill = loadSkill(join(SKILLS_DIR, 'community-discovery'));
    const communityResult = await runSkill<CommunityDiscoveryOutput>({
      skill: communitySkill,
      input: productContext,
      deps: { redditClient },
      outputSchema: communityDiscoveryOutputSchema,
    });

    const MIN_SUBSCRIBERS = 10_000;
    const redditCommunities = communityResult.results
      .flatMap((r) => r.communities)
      .filter(
        (c) =>
          c.platform === 'reddit' &&
          c.audienceFit >= 0.4 &&
          (c.subscribers == null || c.subscribers >= MIN_SUBSCRIBERS),
      )
      .sort((a, b) => b.audienceFit - a.audienceFit);

    subreddits = [
      ...new Set(redditCommunities.map((c) => c.name.replace(/^r\//, ''))),
    ].slice(0, MAX_SCAN_SUBREDDITS);

    discoveredCommunities = redditCommunities
      .slice(0, MAX_SCAN_SUBREDDITS)
      .map((c) => ({
        name: c.name,
        subscribers: c.subscribers ?? undefined,
        audienceFit: c.audienceFit,
        reason: c.reason,
      }));

    if (subreddits.length > 0) {
      log.info(`Community discovery: ${subreddits.join(', ')}`);
      send('community_discovery_done', { communities: discoveredCommunities });
    } else {
      log.warn('Community discovery returned nothing, using fallback');
      subreddits = FALLBACK_SUBREDDITS;
      send('community_discovery_done', { communities: [], fallback: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Community discovery failed: ${message}`);
    subreddits = FALLBACK_SUBREDDITS;
    send('community_discovery_done', { communities: [], fallback: true, error: message });
  }

  // Step 3: Community intelligence (rules + hot posts)
  let communityIntel: CommunityIntelOutput[] = [];

  try {
    send('community_intel_start', { subreddits });

    const intelSkill = loadSkill(join(SKILLS_DIR, 'community-intel'));
    const intelResult = await runSkill<CommunityIntelOutput>({
      skill: intelSkill,
      input: {
        ...productContext,
        subreddits,
      },
      deps: { redditClient },
      outputSchema: communityIntelOutputSchema,
    });

    communityIntel = intelResult.results;
    log.info(`Community intel gathered for ${communityIntel.length} subreddits`);
    send('community_intel_done', { intel: communityIntel });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Community intel failed (non-fatal): ${message}`);
    send('community_intel_done', { intel: [], error: message });
  }

  // Step 4: Thread discovery
  send('discovery_start', { totalCommunities: subreddits.length });

  const discoverySkill = loadSkill(join(SKILLS_DIR, 'discovery'));
  const result = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input: {
      ...productContext,
      subreddits,
    },
    deps: { redditClient },
    outputSchema: discoveryOutputSchema,
    onProgress: (event) => send(event.type, event),
  });

  for (const err of result.errors) {
    log.error(`Agent "${err.label}" failed: ${err.error}`);
    send('agent_error', { subreddit: err.label, error: err.error });
  }

  // Step 5: Merge, dedup, sort
  const seenIds = new Set<string>();
  const allResults: Array<Record<string, unknown>> = [];

  for (const discovery of result.results) {
    for (const thread of discovery.threads) {
      if (seenIds.has(thread.id)) continue;
      seenIds.add(thread.id);

      const hasScored = thread.relevanceScore != null && thread.scores != null;
      const relevanceScore = hasScored
        ? thread.relevanceScore!
        : Math.round(((thread.relevance ?? 0) + (thread.intent ?? 0)) / 2 * 100);
      const scores = hasScored
        ? thread.scores!
        : {
            relevance: Math.round((thread.relevance ?? 0) * 100),
            intent: Math.round((thread.intent ?? 0) * 100),
            exposure: 50,
            freshness: 50,
            engagement: 50,
          };

      // Determine draft type based on community intel
      const subIntel = communityIntel.find(
        (ci) => ci.subreddit.toLowerCase() === thread.subreddit.toLowerCase(),
      );
      const draftType =
        subIntel?.recommendedApproach === 'original_post'
          ? 'original_post'
          : 'reply';

      allResults.push({
        source: 'reddit',
        externalId: thread.id,
        title: thread.title,
        url: thread.url,
        subreddit: thread.subreddit,
        upvotes: thread.score ?? 0,
        commentCount: thread.commentCount ?? 0,
        relevanceScore,
        scores,
        draftType,
        postedAt: thread.createdUtc
          ? new Date(thread.createdUtc * 1000).toISOString()
          : null,
        reason: thread.reason,
      });
    }
  }

  allResults.sort(
    (a, b) => (b.relevanceScore as number) - (a.relevanceScore as number),
  );

  log.info(`Full scan complete: ${allResults.length} results`);

  return {
    product: { name: product.productName, description: product.oneLiner, url },
    communities: discoveredCommunities,
    communityIntel,
    results: allResults,
  };
}
