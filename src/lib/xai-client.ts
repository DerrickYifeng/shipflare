import { createLogger } from '@/lib/logger';

const log = createLogger('lib:xai');

const XAI_BASE_URL = 'https://api.x.ai/v1';
const XAI_MODEL = 'grok-4-fast';
const FETCH_TIMEOUT_MS = 30_000;

export interface XSearchTweet {
  tweetId: string;
  url: string;
  text: string;
  authorUsername: string;
}

interface XAIResponseOutput {
  type: string;
  role?: string;
  content?: Array<{
    type: string;
    text?: string;
    annotations?: Array<{
      type: string;
      url: string;
      start_index: number;
      end_index: number;
      title?: string;
    }>;
  }>;
}

interface XAIResponse {
  id: string;
  output: XAIResponseOutput[];
  citations?: string[];
  server_side_tool_usage?: {
    x_search_calls: number;
    web_search_calls: number;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface XSearchResult {
  tweets: XSearchTweet[];
  rawText: string;
  searchCalls: number;
}

/**
 * xAI Grok API client for searching X/Twitter content.
 * Uses the Responses API with server-side x_search tool.
 * Grok autonomously searches X and returns results with citations.
 */
export class XAIClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.XAI_API_KEY;
    if (!key) {
      throw new Error('XAI_API_KEY is required');
    }
    this.apiKey = key;
  }

  /**
   * Search X/Twitter for tweets matching a query.
   * Grok handles the actual search autonomously via server-side x_search tool.
   */
  async searchTweets(
    query: string,
    opts?: { fromDate?: string; toDate?: string; maxResults?: number; signal?: AbortSignal },
  ): Promise<XSearchResult> {
    const maxResults = opts?.maxResults ?? 10;

    const tools: Array<Record<string, unknown>> = [
      {
        type: 'x_search',
        ...(opts?.fromDate && { from_date: opts.fromDate }),
        ...(opts?.toDate && { to_date: opts.toDate }),
      },
    ];

    const systemPrompt = [
      `You are a search assistant. Find up to ${maxResults} recent, relevant X/Twitter posts matching the user's query.`,
      'For each tweet found, output it in this exact format, one per line:',
      'TWEET|<tweet_url>|<author_username>|<tweet_text_on_one_line>',
      'Only output TWEET lines. No other text, headers, or commentary.',
      'If no relevant tweets are found, output: NO_RESULTS',
    ].join('\n');

    log.debug(`Searching X via xAI: "${query}"`);

    // Compose abort: caller signal (from swarm timeout) + per-request timeout
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(`${XAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          tools,
          input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: query },
          ],
        }),
        signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`xAI API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as XAIResponse;

    const rawText = this.extractText(data);
    const tweetsFromText = this.parseTweetLines(rawText);
    const tweetsFromCitations = this.parseCitations(data.citations ?? []);

    // Merge: prefer structured text output, supplement with citations
    const tweetMap = new Map<string, XSearchTweet>();
    for (const t of tweetsFromCitations) {
      tweetMap.set(t.tweetId, t);
    }
    for (const t of tweetsFromText) {
      tweetMap.set(t.tweetId, t);
    }

    const tweets = Array.from(tweetMap.values()).slice(0, maxResults);

    log.info(
      `xAI search returned ${tweets.length} tweets, ${data.server_side_tool_usage?.x_search_calls ?? 0} search calls`,
    );

    return {
      tweets,
      rawText,
      searchCalls: data.server_side_tool_usage?.x_search_calls ?? 0,
    };
  }

  private extractText(data: XAIResponse): string {
    for (const output of data.output) {
      if (output.type === 'message' && output.content) {
        for (const block of output.content) {
          if (block.type === 'output_text' && block.text) {
            return block.text;
          }
        }
      }
    }
    return '';
  }

  /**
   * Parse structured TWEET lines from Grok's response text.
   * Format: TWEET|url|author|text
   */
  private parseTweetLines(text: string): XSearchTweet[] {
    const tweets: XSearchTweet[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      if (!line.startsWith('TWEET|')) continue;
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const url = parts[1]!.trim();
      const tweetId = this.extractTweetId(url);
      if (!tweetId) continue;

      tweets.push({
        tweetId,
        url,
        authorUsername: parts[2]!.trim().replace(/^@/, ''),
        text: parts.slice(3).join('|').trim(),
      });
    }

    return tweets;
  }

  /**
   * Parse tweet URLs from xAI citations array.
   * Citations contain URLs like https://x.com/user/status/1234567890
   */
  private parseCitations(citations: string[]): XSearchTweet[] {
    const tweets: XSearchTweet[] = [];

    for (const url of citations) {
      const tweetId = this.extractTweetId(url);
      if (!tweetId) continue;

      const usernameMatch = url.match(/x\.com\/([^/]+)\/status\//);
      tweets.push({
        tweetId,
        url,
        authorUsername: usernameMatch?.[1] ?? 'unknown',
        text: '', // Citations don't include tweet text
      });
    }

    return tweets;
  }

  private extractTweetId(url: string): string | null {
    const match = url.match(/\/status\/(\d+)/);
    return match?.[1] ?? null;
  }
}
