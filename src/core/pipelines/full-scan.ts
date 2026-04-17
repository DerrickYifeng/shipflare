import { scrapeUrl, analyzeProduct } from '@/tools/url-scraper';
import type { RedditClient } from '@/lib/reddit-client';
import type { XAIClient } from '@/lib/xai-client';
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
import { PLATFORMS } from '@/lib/platform-config';
import { createPublicPlatformDeps } from '@/lib/platform-deps';

const log = createLogger('pipeline:full-scan');

const SKILLS_DIR = join(process.cwd(), 'src', 'skills');
const MAX_SCAN_SUBREDDITS = 3;
const MAX_RESULTS_PER_PLATFORM = 10;
const FALLBACK_SUBREDDITS = PLATFORMS.reddit.defaultSources;

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
  xaiClient?: XAIClient;
  onProgress?: FullScanProgress;
}): Promise<FullScanResult> {
  const { url, onProgress } = input;
  const send = onProgress ?? (() => {});

  // Resolve anonymous/read-only clients via platform-deps so adding a new
  // read-capable platform is a one-config-entry change.
  const publicDeps = createPublicPlatformDeps();
  const redditClient =
    input.redditClient ?? (publicDeps.redditClient as RedditClient | undefined) ?? null;
  const xaiClient =
    input.xaiClient ?? (publicDeps.xaiClient as XAIClient | undefined) ?? null;

  if (!redditClient) {
    // Reddit is the primary community discovery source; refuse to run
    // if it's unavailable rather than silently degrading to X-only.
    throw new Error('runFullScan requires a Reddit client (app-only is sufficient)');
  }

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
    // Community intel (rules + hot posts) is currently only produced for
    // Reddit-shape communities (subreddits with rules/mods). When a new
    // platform grows equivalent community metadata, add it to this filter.
    const redditCommunities = communityResult.results
      .flatMap((r) => r.communities)
      .filter(
        (c) =>
          c.platform === PLATFORMS.reddit.id &&
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

  // Step 4: Thread discovery (parallel across supported platforms via unified skill)
  const discoverySkill = loadSkill(join(SKILLS_DIR, 'discovery'));
  const xTopics = xaiClient
    ? product.keywords.slice(0, 3).map((k) => k.toLowerCase())
    : [];
  const totalSources = subreddits.length + xTopics.length;
  const activePlatforms = [
    PLATFORMS.reddit.id,
    ...(xaiClient ? [PLATFORMS.x.id] : []),
  ];
  send('discovery_start', { totalCommunities: totalSources, platforms: activePlatforms });

  // 4a: Reddit discovery
  const redditDiscoveryPromise = runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input: {
      ...productContext,
      sources: subreddits,
      platform: PLATFORMS.reddit.id,
    },
    deps: { redditClient },
    outputSchema: discoveryOutputSchema,
    onProgress: (event) => send(event.type, event),
  });

  // 4b: X discovery (parallel, skipped if no xAI key)
  const xDiscoveryPromise = xaiClient
    ? (async () => {
        try {
          send('x_discovery_start', { topics: xTopics });
          const xResult = await runSkill<DiscoveryOutput>({
            skill: discoverySkill,
            input: {
              ...productContext,
              sources: xTopics,
              platform: PLATFORMS.x.id,
            },
            deps: { xaiClient },
            outputSchema: discoveryOutputSchema,
            onProgress: (event) => send(event.type, { ...event, platform: PLATFORMS.x.id }),
          });
          send('x_discovery_done', { count: xResult.results.reduce((n, r) => n + r.threads.length, 0) });
          return xResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`X discovery failed (non-fatal): ${message}`);
          send('x_discovery_done', { count: 0, error: message });
          return null;
        }
      })()
    : Promise.resolve(null);

  const [redditResult, xResult] = await Promise.all([redditDiscoveryPromise, xDiscoveryPromise]);

  for (const err of redditResult.errors) {
    log.error(`Agent "${err.label}" failed: ${err.error}`);
    send('agent_error', { source: err.label, platform: PLATFORMS.reddit.id, error: err.error });
  }
  if (xResult) {
    for (const err of xResult.errors) {
      log.error(`Agent "${err.label}" failed: ${err.error}`);
      send('agent_error', { source: err.label, platform: PLATFORMS.x.id, error: err.error });
    }
  }

  // Step 5: Merge, dedup, sort (cap each platform to MAX_RESULTS_PER_PLATFORM)
  const seenIds = new Set<string>();

  function collectResults(
    skillResult: { results: DiscoveryOutput[] },
    platform: string,
  ): Array<Record<string, unknown>> {
    const collected: Array<Record<string, unknown>> = [];
    for (const discovery of skillResult.results) {
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

        // communityIntel is populated only for platforms with subreddit-style
        // rules metadata — currently Reddit. Other platforms fall through
        // with the default 'reply' draftType.
        let draftType: string = 'reply';
        if (platform === PLATFORMS.reddit.id) {
          const subIntel = communityIntel.find(
            (ci) => ci.community.toLowerCase() === thread.community.toLowerCase(),
          );
          if (subIntel?.recommendedApproach === 'not_recommended') continue;
          if (subIntel?.recommendedApproach === 'original_post') draftType = 'original_post';
        }

        collected.push({
          source: platform,
          externalId: thread.id,
          title: thread.title,
          url: thread.url,
          community: thread.community,
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
    return collected;
  }

  const redditResults = collectResults(redditResult, PLATFORMS.reddit.id);
  const xResults = xResult ? collectResults(xResult, PLATFORMS.x.id) : [];

  // Sort each platform by score, cap at MAX_RESULTS_PER_PLATFORM, then merge
  redditResults.sort((a, b) => (b.relevanceScore as number) - (a.relevanceScore as number));
  xResults.sort((a, b) => (b.relevanceScore as number) - (a.relevanceScore as number));

  const allResults = [
    ...redditResults.slice(0, MAX_RESULTS_PER_PLATFORM),
    ...xResults.slice(0, MAX_RESULTS_PER_PLATFORM),
  ].sort((a, b) => (b.relevanceScore as number) - (a.relevanceScore as number));

  log.info(`Full scan complete: ${allResults.length} results (reddit: ${redditResult.results.reduce((n, r) => n + r.threads.length, 0)}, x: ${xResult?.results.reduce((n, r) => n + r.threads.length, 0) ?? 0})`);

  return {
    product: { name: product.productName, description: product.oneLiner, url },
    communities: discoveredCommunities,
    communityIntel,
    results: allResults,
  };
}
