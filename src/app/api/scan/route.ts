import { scrapeUrl } from '@/tools/url-scraper';
import { RedditClient } from '@/lib/reddit-client';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { redditSearchTool } from '@/tools/reddit-search';
import type { ToolDefinition } from '@/bridge/types';
import type { AgentProgressEvent } from '@/bridge/types';
import { queryOutputSchema, discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { join } from 'path';

// --- Multi-dimensional scoring ---

const SCORE_WEIGHTS = {
  relevance: 0.30,
  intent: 0.25,
  exposure: 0.20,
  freshness: 0.15,
  engagement: 0.10,
};

function scoreExposure(upvotes: number, comments: number): number {
  const total = Math.max(upvotes, 0) + Math.max(comments, 0);
  if (total <= 0) return 0.05;
  return Math.min(1.0, Math.log10(total + 1) / 3);
}

function scoreFreshness(createdUtc: number): number {
  const ageHours = (Date.now() / 1000 - createdUtc) / 3600;
  if (ageHours <= 0) return 1.0;
  return Math.max(0.05, Math.exp(-0.023 * ageHours));
}

function scoreEngagement(upvotes: number, comments: number): number {
  if (comments <= 0) return 0.05;
  const commentScore = Math.min(1.0, Math.log10(comments + 1) / 2.5);
  const ratio = upvotes > 0 ? comments / upvotes : 1;
  const ratioBonus = Math.min(0.3, ratio * 0.15);
  return Math.min(1.0, commentScore + ratioBonus);
}

interface ScoreDimensions {
  relevance: number;
  intent: number;
  exposure: number;
  freshness: number;
  engagement: number;
}

function computeWeightedScore(dims: ScoreDimensions): number {
  return (
    dims.relevance * SCORE_WEIGHTS.relevance +
    dims.intent * SCORE_WEIGHTS.intent +
    dims.exposure * SCORE_WEIGHTS.exposure +
    dims.freshness * SCORE_WEIGHTS.freshness +
    dims.engagement * SCORE_WEIGHTS.engagement
  );
}

const SCAN_SUBREDDITS = [
  'SideProject',
  'startups',
  'webdev',
  'SaaS',
  'indiehackers',
  'Entrepreneur',
  'smallbusiness',
  'selfhosted',
  'devops',
  'programming',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emptyToolRegistry = new Map<string, ToolDefinition<any, any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const searchToolRegistry = new Map<string, ToolDefinition<any, any>>([
  ['reddit_search', redditSearchTool],
]);

const AGENTS_DIR = join(process.cwd(), 'src/agents');

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Public scan endpoint. Two-stage agent flow with SSE streaming:
 * 1. Query agent → generates pain-point search queries
 * 2. Discovery agents → fan out in parallel, one per subreddit
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const url = body.url;

  if (!url || typeof url !== 'string') {
    return Response.json({ error: 'URL is required' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(sseEncode(event, data)));
      }

      try {
        // Step 1: Scrape URL
        const scraped = await scrapeUrl(url);
        const productName = extractProductName(scraped.title, url);

        send('scrape_done', {
          productName,
          description: scraped.description,
          keywords: scraped.keywords,
        });

        // Step 2: Query agent — generate pain-point search queries
        const queryAgent = loadAgentFromFile(
          join(AGENTS_DIR, 'query.md'),
          emptyToolRegistry,
        );

        const queryInput = JSON.stringify({
          productName,
          productDescription: scraped.description,
          keywords: scraped.keywords,
          valueProp: scraped.valueProp || productName,
          subreddits: SCAN_SUBREDDITS,
        });

        const { result: queryResult } = await runAgent(
          queryAgent,
          queryInput,
          createToolContext({}),
          queryOutputSchema,
        );

        const subredditsWithQueries = Object.entries(queryResult.subredditQueries);

        send('query_done', {
          subredditCount: subredditsWithQueries.length,
          queriesPerSubreddit: subredditsWithQueries[0]?.[1]?.length ?? 0,
        });

        // Step 3: Fan out discovery agents in parallel (one per subreddit)
        const redditClient = RedditClient.appOnly();
        const discoveryAgent = loadAgentFromFile(
          join(AGENTS_DIR, 'discovery.md'),
          searchToolRegistry,
        );

        const discoveryPromises = subredditsWithQueries.map(
          ([subreddit, queries]) => {
            const context = createToolContext({ redditClient });
            const userMessage = JSON.stringify({
              productName,
              productDescription: scraped.description,
              valueProp: scraped.valueProp || productName,
              subreddit,
              queries,
            });

            const onProgress = (event: AgentProgressEvent) => {
              // Tag progress events with subreddit for client-side grouping
              send(event.type, { ...event, subreddit });
            };

            return runAgent(
              discoveryAgent,
              userMessage,
              context,
              discoveryOutputSchema,
              onProgress,
            ).catch((error): null => {
              const message = error instanceof Error ? error.message : String(error);
              send('agent_error', { subreddit, error: message });
              return null;
            });
          },
        );

        const discoveryResults = await Promise.all(discoveryPromises);

        // Step 4: Merge, deduplicate, score, send results
        const seenIds = new Set<string>();
        const allThreads: DiscoveryOutput['threads'] = [];

        for (const dr of discoveryResults) {
          if (!dr) continue;
          for (const thread of dr.result.threads) {
            if (seenIds.has(thread.id)) continue;
            seenIds.add(thread.id);
            allThreads.push(thread);
          }
        }

        const results = allThreads
          .map((t) => {
            const dims: ScoreDimensions = {
              relevance: t.relevance,
              intent: t.intent,
              exposure: scoreExposure(t.score ?? 0, t.commentCount ?? 0),
              freshness: scoreFreshness(t.createdUtc ?? 0),
              engagement: scoreEngagement(t.score ?? 0, t.commentCount ?? 0),
            };
            const weightedScore = computeWeightedScore(dims);

            return {
              source: 'reddit' as const,
              externalId: t.id,
              title: t.title,
              url: t.url,
              subreddit: t.subreddit,
              upvotes: t.score ?? 0,
              commentCount: t.commentCount ?? 0,
              relevanceScore: Math.round(weightedScore * 100),
              scores: {
                relevance: Math.round(dims.relevance * 100),
                intent: Math.round(dims.intent * 100),
                exposure: Math.round(dims.exposure * 100),
                freshness: Math.round(dims.freshness * 100),
                engagement: Math.round(dims.engagement * 100),
              },
              postedAt: t.createdUtc
                ? new Date(t.createdUtc * 1000).toISOString()
                : null,
              reason: t.reason,
            };
          })
          .sort((a, b) => b.relevanceScore - a.relevanceScore);

        send('complete', {
          product: { name: productName, description: scraped.description, url },
          results,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send('error', { error: `Scan failed: ${message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function extractProductName(title: string, url: string): string {
  const separators = /\s*[–\-|:·]\s*/;
  const parts = title.split(separators).map((p) => p.trim()).filter(Boolean);

  if (parts.length > 1 && parts[0].split(/\s+/).length <= 4) {
    return parts[0];
  }

  const hostname = new URL(url).hostname.replace(/^www\./, '');
  return hostname.split('.')[0];
}
