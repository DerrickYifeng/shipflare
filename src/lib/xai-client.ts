import { createLogger } from '@/lib/logger';

const log = createLogger('lib:xai');

const XAI_BASE_URL = 'https://api.x.ai/v1';
const XAI_MODEL = 'grok-4.20-non-reasoning';
const FETCH_TIMEOUT_MS = 50_000;
const FETCH_RETRY_TIMEOUT_MS = 60_000;

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

export interface XSearchBatchInput {
  id: string;
  query: string;
  maxResults?: number;
}

export interface XSearchBatchResult {
  queryId: string;
  tweets: XSearchTweet[];
}

export interface XAuthorBio {
  username: string;
  bio: string | null;
  followerCount: number | null;
}

export interface ConversationalMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationalResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    schema: object;
    strict: boolean;
  };
}

export interface ConversationalRequest {
  /** xAI model id, e.g. `grok-4.20-non-reasoning` or `grok-4.20-reasoning`. */
  model: string;
  messages: ConversationalMessage[];
  tools?: Array<{ type: 'x_search' | 'web_search' }>;
  responseFormat?: ConversationalResponseFormat;
  signal?: AbortSignal;
}

export interface ConversationalResponse {
  /** Parsed JSON when `responseFormat.type === 'json_schema'`; raw string otherwise. */
  output: unknown;
  /** Verbatim assistant message — agent threads this back into the next call. */
  assistantMessage: ConversationalMessage;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * Self-imposed cap on queries per `searchTweetsBatch` call. Not an xAI
 * API limit — the Grok responses endpoint accepts longer prompts. We
 * cap at 20 to bound the response token count and to align with
 * `RunDiscoveryScanTool`'s `inlineQueryCount.max(20)` so a scout that
 * generates breadth-spanning query sets at kickoff doesn't trip the
 * Zod guard. Bumped from 10 after a kickoff scan with 12 queries
 * failed validation in production (2026-04-26).
 */
export const SEARCH_TWEETS_BATCH_MAX_QUERIES = 20;

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

    const requestBody = JSON.stringify({
      model: XAI_MODEL,
      tools,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
    });

    let data: XAIResponse;
    try {
      data = await this.fetchWithTimeout(requestBody, FETCH_TIMEOUT_MS, opts?.signal);
    } catch (err) {
      // On timeout, retry once with a longer timeout
      if (err instanceof Error && err.name === 'AbortError') {
        log.warn(`xAI search timed out after ${FETCH_TIMEOUT_MS}ms, retrying with ${FETCH_RETRY_TIMEOUT_MS}ms`);
        data = await this.fetchWithTimeout(requestBody, FETCH_RETRY_TIMEOUT_MS, opts?.signal);
      } else {
        throw err;
      }
    }

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

  /**
   * Run multiple X/Twitter searches in one Grok call. Grok's server-side
   * `x_search` tool is invoked once per query in parallel (still counts as
   * multiple `x_search_calls` for billing, but saves the Responses-API
   * round-trip, prompt duplication, and most of the wall-clock latency).
   *
   * Callers must pass unique ids — results are returned keyed by those ids.
   * Unknown ids in Grok's output are dropped; queries that produce zero
   * results come back with `tweets: []` rather than being omitted.
   *
   * Upstream callers wanting retry-on-partial-failure should compare the
   * returned `tweets.length` per query against expectations and fall back
   * to `searchTweets()` for any misses. This method does not auto-fallback
   * — a single malformed response shouldn't silently amplify cost.
   */
  async searchTweetsBatch(
    queries: XSearchBatchInput[],
    opts?: { signal?: AbortSignal },
  ): Promise<XSearchBatchResult[]> {
    if (queries.length === 0) return [];
    if (queries.length > SEARCH_TWEETS_BATCH_MAX_QUERIES) {
      throw new Error(
        `searchTweetsBatch: max ${SEARCH_TWEETS_BATCH_MAX_QUERIES} queries per call, got ${queries.length}`,
      );
    }
    const ids = new Set<string>();
    for (const q of queries) {
      if (ids.has(q.id)) {
        throw new Error(`searchTweetsBatch: duplicate query id ${q.id}`);
      }
      ids.add(q.id);
    }

    const systemPrompt = [
      'You are a batch X/Twitter search assistant. For each query listed by the user, run an x_search and return the matching tweets.',
      'Output format — one line per tweet:',
      'TWEET|<query_id>|<tweet_url>|<author_username>|<tweet_text_on_one_line>',
      'If a query has zero results, output exactly one line: NO_RESULTS|<query_id>',
      'Rules:',
      '- Output ONLY TWEET and NO_RESULTS lines. No headers, commentary, or blank lines.',
      '- Use the exact query_id provided in brackets — never invent new ids.',
      '- Respect each query\'s maxResults cap.',
      '- Replace any newlines inside tweet text with spaces so each tweet stays on one line.',
    ].join('\n');

    const userLines = queries
      .map(
        (q) =>
          `[${q.id}] (maxResults=${q.maxResults ?? 10}) ${q.query}`,
      )
      .join('\n');

    const requestBody = JSON.stringify({
      model: XAI_MODEL,
      tools: [{ type: 'x_search' }],
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userLines },
      ],
    });

    log.debug(`Batch searching X via xAI: ${queries.length} queries`);

    let data: XAIResponse;
    try {
      data = await this.fetchWithTimeout(requestBody, FETCH_TIMEOUT_MS, opts?.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.warn(
          `xAI batch search timed out after ${FETCH_TIMEOUT_MS}ms, retrying with ${FETCH_RETRY_TIMEOUT_MS}ms`,
        );
        data = await this.fetchWithTimeout(
          requestBody,
          FETCH_RETRY_TIMEOUT_MS,
          opts?.signal,
        );
      } else {
        throw err;
      }
    }

    const rawText = this.extractText(data);
    const grouped = this.parseBatchLines(rawText, ids);

    const totalTweets = Array.from(grouped.values()).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    log.info(
      `xAI batch search: ${queries.length} queries → ${totalTweets} tweets, ${data.server_side_tool_usage?.x_search_calls ?? 0} search calls`,
    );

    return queries.map((q) => ({
      queryId: q.id,
      tweets: (grouped.get(q.id) ?? []).slice(0, q.maxResults ?? 10),
    }));
  }

  /**
   * Look up a handful of X/Twitter author bios in one Grok call.
   *
   * Used by the discovery pipeline to filter out competitors and
   * growth-marketing grifters before inserting candidates. Bios are fetched
   * via Grok's server-side `x_search` tool; not guaranteed to resolve every
   * handle (Grok returns `UNKNOWN|<handle>` for anything it can't find).
   */
  async fetchUserBios(
    usernames: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<XAuthorBio[]> {
    const unique = [...new Set(usernames.map((u) => u.replace(/^@/, '')))].filter(
      Boolean,
    );
    if (unique.length === 0) return [];

    const systemPrompt = [
      'You are an X/Twitter profile lookup assistant. For each @handle the user provides, look up the current profile and return one line in this exact format:',
      'BIO|<handle>|<follower_count_as_integer_or_unknown>|<bio_text_on_one_line_newlines_replaced_with_space>',
      'If you cannot find the profile, return: UNKNOWN|<handle>',
      'Output only BIO and UNKNOWN lines, one per handle, no headers, commentary, or blank lines.',
      'Resolve each handle exactly once, in the order provided.',
    ].join('\n');

    const requestBody = JSON.stringify({
      model: XAI_MODEL,
      tools: [{ type: 'x_search' }],
      input: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Look up these X handles: ${unique.map((u) => `@${u}`).join(', ')}`,
        },
      ],
    });

    log.debug(`Fetching bios for ${unique.length} handles via xAI`);

    let data: XAIResponse;
    try {
      data = await this.fetchWithTimeout(requestBody, FETCH_TIMEOUT_MS, opts?.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.warn(`xAI bio lookup timed out, retrying with longer timeout`);
        data = await this.fetchWithTimeout(
          requestBody,
          FETCH_RETRY_TIMEOUT_MS,
          opts?.signal,
        );
      } else {
        throw err;
      }
    }

    const rawText = this.extractText(data);
    const results: XAuthorBio[] = [];
    for (const line of rawText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('BIO|')) {
        const parts = trimmed.split('|');
        if (parts.length < 4) continue;
        const handle = parts[1]!.trim().replace(/^@/, '');
        const followerStr = parts[2]!.trim();
        const bio = parts.slice(3).join('|').trim();
        const followerCount = /^\d+$/.test(followerStr)
          ? parseInt(followerStr, 10)
          : null;
        results.push({ username: handle, bio: bio || null, followerCount });
      } else if (trimmed.startsWith('UNKNOWN|')) {
        const handle = trimmed.slice('UNKNOWN|'.length).trim().replace(/^@/, '');
        if (handle) results.push({ username: handle, bio: null, followerCount: null });
      }
    }

    log.info(
      `xAI bio lookup resolved ${results.filter((r) => r.bio).length}/${unique.length} handles`,
    );
    return results;
  }

  /**
   * One-shot call to xAI Responses API with explicit messages history,
   * server-side tools, and structured-output response format. Stateless —
   * caller owns the conversation history and re-sends it each call.
   *
   * Used by the discovery-agent's `xai_find_customers` tool to talk to
   * Grok conversationally about which tweets are reply targets for the
   * founder's product.
   *
   * On non-2xx HTTP: throws `xAI API error <status>: <body>`.
   * On JSON parse failure when `responseFormat.type === 'json_schema'`:
   *   throws `schema-construction-bug: ...` — indicates we built an
   *   unsupported schema. xAI guarantees match for supported features
   *   (per https://docs.x.ai/.../structured-outputs); a parse failure
   *   means our toolside bug, not runtime variance. Don't paper over.
   */
  async respondConversational(
    args: ConversationalRequest,
  ): Promise<ConversationalResponse> {
    const requestBody = JSON.stringify({
      model: args.model,
      input: args.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
      ...(args.responseFormat ? { response_format: args.responseFormat } : {}),
    });

    let data: XAIResponse;
    try {
      data = await this.fetchWithTimeout(
        requestBody,
        FETCH_TIMEOUT_MS,
        args.signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // One retry on timeout — same retry policy as searchTweetsBatch.
        log.warn(
          `respondConversational timed out after ${FETCH_TIMEOUT_MS}ms, retrying with ${FETCH_RETRY_TIMEOUT_MS}ms`,
        );
        data = await this.fetchWithTimeout(
          requestBody,
          FETCH_RETRY_TIMEOUT_MS,
          args.signal,
        );
      } else {
        throw err;
      }
    }

    const text = this.extractText(data);
    let output: unknown = text;
    if (args.responseFormat?.type === 'json_schema') {
      try {
        output = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `schema-construction-bug: xAI output_text did not parse as JSON ` +
            `despite response_format=json_schema. ` +
            `text="${text.slice(0, 200)}..." parseError=${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
    }

    return {
      output,
      assistantMessage: { role: 'assistant', content: text },
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  private async fetchWithTimeout(
    body: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<XAIResponse> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(`${XAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`xAI API error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as XAIResponse;
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
   * Parse the batched Grok response into tweets grouped by query id.
   * Lines with unknown ids are dropped. NO_RESULTS lines are no-ops — the
   * caller already pre-seeds empty arrays for every requested id.
   */
  private parseBatchLines(
    text: string,
    validIds: ReadonlySet<string>,
  ): Map<string, XSearchTweet[]> {
    const out = new Map<string, XSearchTweet[]>();
    for (const id of validIds) out.set(id, []);

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('TWEET|')) continue;
      const parts = trimmed.split('|');
      if (parts.length < 5) continue;

      const queryId = parts[1]!.trim();
      if (!validIds.has(queryId)) continue;

      const url = parts[2]!.trim();
      const tweetId = this.extractTweetId(url);
      if (!tweetId) continue;

      out.get(queryId)!.push({
        tweetId,
        url,
        authorUsername: parts[3]!.trim().replace(/^@/, ''),
        text: parts.slice(4).join('|').trim(),
      });
    }

    return out;
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
