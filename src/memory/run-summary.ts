import { sideQuery } from '@/core/api-client';
import { z } from 'zod';
import { runSummaryOutputSchema } from '@/agents/schemas';
import type { RunSummaryOutput } from '@/agents/schemas';

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Run summary prompt adapted from engine/services/compact/prompt.ts.
 *
 * The engine uses a 9-section structured summary for conversation compaction.
 * We adapt the pattern for marketing pipeline runs: what was scanned, what was
 * found, what strategies were used, what failed, and what to do next.
 */
const RUN_SUMMARY_PROMPT = `You are a marketing pipeline analyst. Your job is to create a structured summary of an agent pipeline run for display in a dashboard.

Your summary should be thorough in capturing operational patterns and strategic insights that would help the user understand what happened and what to do next.

Before providing your final summary, analyze the data carefully:
1. Identify which subreddits performed best and worst
2. Note any patterns in thread relevance or content confidence
3. Flag failures or anomalies that need attention
4. Derive actionable next steps from the data

Your summary must be structured as JSON matching the output schema. Focus on:
- **title**: A distinctive 5-10 word summary of the run (e.g., "Strong discovery in r/SaaS, 3 high-confidence drafts")
- **topPerformingSubreddits**: Ranked by thread count and average relevance
- **strategiesUsed**: Query patterns or content approaches that worked
- **failures**: Agent failures, timeouts, subreddits with zero results
- **keyInsights**: Non-obvious patterns worth remembering (these may feed into agent memory)
- **nextActions**: Concrete suggestions for the next run

Be terse. High signal only. No filler.`;

interface RunData {
  subreddits: string[];
  threadsFound: number;
  newThreads: number;
  draftsCreated: number;
  threadsBySubreddit: Record<string, { count: number; avgRelevance: number }>;
  failures: string[];
  draftConfidences: number[];
  totalCostUsd: number;
}

/**
 * Generate a structured run summary from pipeline data.
 * Called after a discovery + content pipeline completes.
 */
export async function generateRunSummary(
  data: RunData,
  signal?: AbortSignal,
): Promise<RunSummaryOutput> {
  const userMessage = JSON.stringify(data);

  const response = await sideQuery({
    model: SUMMARY_MODEL,
    system: RUN_SUMMARY_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Summarize this pipeline run:\n\n${userMessage}\n\nReturn JSON matching the run summary schema.`,
      },
    ],
    maxTokens: 2048,
    signal,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return fallbackSummary(data);
  }

  try {
    const jsonStr = extractJson(textBlock.text);
    return runSummaryOutputSchema.parse(JSON.parse(jsonStr));
  } catch {
    return fallbackSummary(data);
  }
}

/**
 * Fallback: construct a summary without LLM if parsing fails.
 */
function fallbackSummary(data: RunData): RunSummaryOutput {
  const topSubs = Object.entries(data.threadsBySubreddit)
    .map(([subreddit, stats]) => ({
      subreddit,
      threadCount: stats.count,
      avgRelevance: stats.avgRelevance,
    }))
    .sort((a, b) => b.threadCount - a.threadCount);

  return {
    title: `Discovery: ${data.threadsFound} threads across ${data.subreddits.length} subreddits`,
    subredditsScanned: data.subreddits,
    threadsFound: data.threadsFound,
    newThreads: data.newThreads,
    draftsCreated: data.draftsCreated,
    topPerformingSubreddits: topSubs.slice(0, 5),
    strategiesUsed: [],
    failures: data.failures,
    keyInsights: [],
    nextActions: [],
  };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match?.[1]) return match[1].trim();
  const objMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (objMatch?.[1]) return objMatch[1];
  return trimmed;
}
