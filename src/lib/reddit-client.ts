import { decrypt, encrypt } from '@/lib/encryption';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:reddit');

/**
 * Thrown when the Reddit API rate limit is exhausted.
 * Callers should stop making requests and use partial results.
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_PUBLIC_BASE = 'https://www.reddit.com';
const TOKEN_BUFFER_SECONDS = 300; // Refresh 5 min before expiry

// --- Async mutex for concurrency-safe rate limiting ---

function createMutex() {
  let lock: Promise<void> = Promise.resolve();
  return {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      let release: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = lock;
      lock = next;
      await prev;
      try {
        return await fn();
      } finally {
        release!();
      }
    },
  };
}

// --- Module-level shared state for appOnly instances (Reddit rate-limits public API by IP) ---

const APP_ONLY_RATE_LIMIT = 25; // Public .json API is ~30/min/IP, leave buffer
const OAUTH_RATE_LIMIT = 55; // OAuth is 60/min/token, leave buffer
const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

const appOnlyState = {
  mutex: createMutex(),
  requestCount: 0,
  windowStart: Date.now(),
  cache: new Map<string, { data: unknown; expiresAt: number }>(),
};

interface RedditThread {
  id: string;
  title: string;
  url: string;
  selftext: string;
  author: string;
  subreddit: string;
  score: number;
  num_comments: number;
  created_utc: number;
  locked: boolean;
  archived: boolean;
  permalink: string;
}

interface RedditComment {
  id: string;
  permalink: string;
  body: string;
  author: string;
}

/**
 * Reddit OAuth API client with automatic token refresh and rate limiting.
 * Rate limit: 60 requests per minute per OAuth token.
 */
export class RedditClient {
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: Date;
  private channelId: string;
  private requestCount = 0;
  private windowStart = Date.now();
  private instanceMutex = createMutex();
  private cache = new Map<string, { data: unknown; expiresAt: number }>();

  constructor(
    channelId: string,
    encryptedAccess: string,
    encryptedRefresh: string,
    expiresAt: Date | null,
  ) {
    this.channelId = channelId;
    this.accessToken = decrypt(encryptedAccess);
    this.refreshToken = decrypt(encryptedRefresh);
    this.expiresAt = expiresAt ?? new Date(0);
  }

  /**
   * Create a RedditClient from a channel database record.
   */
  static fromChannel(channel: {
    id: string;
    oauthTokenEncrypted: string;
    refreshTokenEncrypted: string;
    tokenExpiresAt: Date | null;
  }): RedditClient {
    return new RedditClient(
      channel.id,
      channel.oauthTokenEncrypted,
      channel.refreshTokenEncrypted,
      channel.tokenExpiresAt,
    );
  }

  /**
   * Create a RedditClient using the public JSON API (no OAuth).
   * Read-only access. Used for the public scan endpoint.
   */
  static appOnly(): RedditClient {
    const instance = Object.create(RedditClient.prototype) as RedditClient;
    instance['channelId'] = 'app-only';
    instance['accessToken'] = '';
    instance['refreshToken'] = '';
    instance['expiresAt'] = new Date(Date.now() + 86400_000);
    instance['requestCount'] = 0;
    instance['windowStart'] = Date.now();
    instance['instanceMutex'] = createMutex();
    instance['cache'] = new Map();
    return instance;
  }

  /**
   * Search a subreddit for threads matching a query.
   */
  async searchSubreddit(
    subreddit: string,
    query: string,
    limit = 10,
  ): Promise<RedditThread[]> {
    const cache = this.channelId === 'app-only' ? appOnlyState.cache : this.cache;
    const cacheKey = `search:${subreddit}:${query}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      log.debug(`Cache hit: ${cacheKey}`);
      return cached.data as RedditThread[];
    }

    const params = new URLSearchParams({
      q: query,
      sort: 'new',
      limit: String(limit),
      restrict_sr: 'true',
      t: 'week',
    });

    const data = await this.get(
      `/r/${subreddit}/search?${params.toString()}`,
    );
    const listing = data as { data: { children: Array<{ data: RedditThread }> } };
    const results = listing.data.children.map((c) => c.data);
    cache.set(cacheKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
    return results;
  }

  /**
   * Post a comment on a thread.
   */
  async postComment(
    threadFullname: string,
    text: string,
  ): Promise<{ id: string; permalink: string }> {
    const data = await this.post('/api/comment', {
      thing_id: threadFullname,
      text,
    });

    const response = data as {
      json: { data: { things: Array<{ data: { id: string; permalink: string } }> } };
    };
    const comment = response.json.data.things[0]?.data;
    if (!comment) {
      throw new Error('Reddit API: no comment returned after posting');
    }
    return { id: comment.id, permalink: comment.permalink };
  }

  /**
   * Verify a comment exists (shadowban detection).
   */
  async getComment(commentId: string): Promise<{
    exists: boolean;
    removed: boolean;
    body?: string;
  }> {
    try {
      const data = await this.get(`/api/info?id=t1_${commentId}`);
      const listing = data as {
        data: { children: Array<{ data: { body: string; removed?: boolean; author: string } }> };
      };
      const comment = listing.data.children[0]?.data;

      if (!comment) {
        return { exists: false, removed: false };
      }

      // Shadowban: comment exists but author is [deleted] or body is [removed]
      const removed =
        comment.author === '[deleted]' || comment.body === '[removed]';

      return { exists: true, removed, body: comment.body };
    } catch {
      return { exists: false, removed: false };
    }
  }

  /**
   * Search for subreddits matching a query.
   * Uses GET /subreddits/search endpoint.
   */
  async searchSubreddits(
    query: string,
    limit = 10,
  ): Promise<Array<{
    name: string;
    subscribers: number;
    description: string;
    activeUsers: number;
    createdUtc: number;
  }>> {
    const cache = this.channelId === 'app-only' ? appOnlyState.cache : this.cache;
    const cacheKey = `subs:${query}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      log.debug(`Cache hit: ${cacheKey}`);
      return cached.data as Array<{
        name: string;
        subscribers: number;
        description: string;
        activeUsers: number;
        createdUtc: number;
      }>;
    }

    const params = new URLSearchParams({
      q: query,
      sort: 'relevance',
      limit: String(limit),
    });

    const data = await this.get(`/subreddits/search?${params.toString()}`);
    const listing = data as {
      data: {
        children: Array<{
          data: {
            display_name: string;
            subscribers: number;
            public_description: string;
            accounts_active: number;
            created_utc: number;
          };
        }>;
      };
    };

    const results = listing.data.children.map((c) => ({
      name: c.data.display_name,
      subscribers: c.data.subscribers ?? 0,
      description: c.data.public_description ?? '',
      activeUsers: c.data.accounts_active ?? 0,
      createdUtc: c.data.created_utc ?? 0,
    }));
    cache.set(cacheKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
    return results;
  }

  /**
   * Get a thread's full comment tree.
   * Uses GET /comments/{articleId} endpoint.
   */
  async getThread(
    subreddit: string,
    articleId: string,
    sort: 'confidence' | 'top' | 'new' = 'confidence',
    limit = 50,
  ): Promise<{
    thread: RedditThread;
    comments: Array<{
      id: string;
      author: string;
      body: string;
      score: number;
      createdUtc: number;
      depth: number;
    }>;
  }> {
    const params = new URLSearchParams({
      sort,
      limit: String(limit),
      depth: '3',
    });

    const data = await this.get(
      `/r/${subreddit}/comments/${articleId}?${params.toString()}`,
    );

    // Reddit returns an array of two listings: [thread, comments]
    const listings = data as Array<{
      data: {
        children: Array<{ kind: string; data: Record<string, unknown> }>;
      };
    }>;

    const threadData = listings[0]?.data.children[0]?.data as unknown as RedditThread;
    const commentChildren = listings[1]?.data.children ?? [];

    const comments: Array<{
      id: string;
      author: string;
      body: string;
      score: number;
      createdUtc: number;
      depth: number;
    }> = [];

    function flattenComments(
      children: Array<{ kind: string; data: Record<string, unknown> }>,
      depth: number,
    ) {
      for (const child of children) {
        if (child.kind !== 't1') continue;
        const d = child.data;
        comments.push({
          id: d.id as string,
          author: d.author as string,
          body: ((d.body as string) ?? '').slice(0, 1000),
          score: (d.score as number) ?? 0,
          createdUtc: (d.created_utc as number) ?? 0,
          depth,
        });
        // Recurse into replies
        const replies = d.replies as { data?: { children?: Array<{ kind: string; data: Record<string, unknown> }> } } | undefined;
        if (replies?.data?.children) {
          flattenComments(replies.data.children, depth + 1);
        }
      }
    }

    flattenComments(commentChildren, 0);

    return { thread: threadData, comments };
  }

  /**
   * Submit a new self-post (text thread) to a subreddit.
   * Requires OAuth (not available on app-only).
   */
  async submitPost(
    subreddit: string,
    title: string,
    text: string,
  ): Promise<{ id: string; url: string }> {
    const data = await this.post('/api/submit', {
      sr: subreddit,
      kind: 'self',
      title,
      text,
    });

    const response = data as {
      json: { data: { id: string; url: string; name: string } };
    };
    const post = response.json?.data;
    if (!post?.url) {
      throw new Error('Reddit API: no post returned after submission');
    }
    return { id: post.id ?? post.name, url: post.url };
  }

  /**
   * Get a subreddit's rules.
   */
  async getSubredditRules(
    subreddit: string,
  ): Promise<Array<{ title: string; description: string; kind: string }>> {
    const cache = this.channelId === 'app-only' ? appOnlyState.cache : this.cache;
    const cacheKey = `rules:${subreddit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as Array<{ title: string; description: string; kind: string }>;
    }

    const data = await this.get(`/r/${subreddit}/about/rules`);
    const response = data as {
      rules: Array<{
        short_name: string;
        description: string;
        kind: string;
      }>;
    };

    const rules = (response.rules ?? []).map((r) => ({
      title: r.short_name,
      description: r.description ?? '',
      kind: r.kind ?? 'all',
    }));
    cache.set(cacheKey, { data: rules, expiresAt: Date.now() + CACHE_TTL_MS });
    return rules;
  }

  /**
   * Get hot posts from a subreddit.
   */
  async getHotPosts(
    subreddit: string,
    limit = 10,
  ): Promise<
    Array<{
      title: string;
      score: number;
      commentCount: number;
      flair: string;
      createdUtc: number;
    }>
  > {
    const cache = this.channelId === 'app-only' ? appOnlyState.cache : this.cache;
    const cacheKey = `hot:${subreddit}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as Array<{
        title: string;
        score: number;
        commentCount: number;
        flair: string;
        createdUtc: number;
      }>;
    }

    const params = new URLSearchParams({ limit: String(limit) });
    const data = await this.get(`/r/${subreddit}/hot?${params.toString()}`);
    const listing = data as {
      data: {
        children: Array<{
          data: {
            title: string;
            score: number;
            num_comments: number;
            link_flair_text: string | null;
            created_utc: number;
          };
        }>;
      };
    };

    const posts = listing.data.children.map((c) => ({
      title: c.data.title,
      score: c.data.score,
      commentCount: c.data.num_comments,
      flair: c.data.link_flair_text ?? '',
      createdUtc: c.data.created_utc,
    }));
    cache.set(cacheKey, { data: posts, expiresAt: Date.now() + CACHE_TTL_MS });
    return posts;
  }

  /**
   * Get the authenticated user's account info.
   */
  async getAccountInfo(): Promise<{ name: string; id: string }> {
    const data = await this.get('/api/v1/me');
    const me = data as { name: string; id: string };
    return me;
  }

  private async ensureValidToken(): Promise<void> {
    const now = new Date();
    const bufferDate = new Date(
      this.expiresAt.getTime() - TOKEN_BUFFER_SECONDS * 1000,
    );

    if (now < bufferDate) return;

    // App-only tokens can't be refreshed (no refresh token)
    if (this.channelId === 'app-only') {
      throw new Error('App-only Reddit token expired');
    }

    // Refresh the token
    log.debug('Refreshing Reddit OAuth token');
    const response = await fetch(
      'https://www.reddit.com/api/v1/access_token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`,
          ).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Reddit token refresh failed: ${response.status}`);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = tokens.access_token;
    this.expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Persist encrypted tokens to DB
    await db
      .update(channels)
      .set({
        oauthTokenEncrypted: encrypt(this.accessToken),
        tokenExpiresAt: this.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, this.channelId));
  }

  private async rateLimitCheck(): Promise<void> {
    if (this.channelId === 'app-only') {
      // All appOnly instances share one counter (Reddit limits public API by IP)
      await appOnlyState.mutex.runExclusive(async () => {
        const now = Date.now();
        if (now - appOnlyState.windowStart > 60_000) {
          appOnlyState.requestCount = 0;
          appOnlyState.windowStart = now;
        }
        if (appOnlyState.requestCount >= APP_ONLY_RATE_LIMIT) {
          const waitMs = 60_000 - (now - appOnlyState.windowStart);
          log.warn(`Reddit rate limit exhausted (app-only shared), ${Math.ceil(waitMs / 1000)}s until reset`);
          throw new RateLimitError(
            `Reddit rate limit reached, resets in ${Math.ceil(waitMs / 1000)}s`,
          );
        }
        appOnlyState.requestCount++;
      });
    } else {
      // OAuth: per-instance mutex (Reddit limits by token)
      await this.instanceMutex.runExclusive(async () => {
        const now = Date.now();
        if (now - this.windowStart > 60_000) {
          this.requestCount = 0;
          this.windowStart = now;
        }
        if (this.requestCount >= OAUTH_RATE_LIMIT) {
          const waitMs = 60_000 - (now - this.windowStart);
          log.warn(`Reddit rate limit exhausted (oauth), ${Math.ceil(waitMs / 1000)}s until reset`);
          throw new RateLimitError(
            `Reddit rate limit reached, resets in ${Math.ceil(waitMs / 1000)}s`,
          );
        }
        this.requestCount++;
      });
    }
  }

  /** Sync local rate-limit counter from Reddit's response headers (OAuth only). */
  private syncFromHeaders(headers: Headers): void {
    if (this.channelId === 'app-only') return; // Public API doesn't send these
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (remaining !== null && reset !== null) {
      this.requestCount = OAUTH_RATE_LIMIT - Math.floor(parseFloat(remaining));
      this.windowStart = Date.now() - (60_000 - parseFloat(reset) * 1000);
    }
  }

  private async get(path: string, retried = false): Promise<unknown> {
    await this.rateLimitCheck();

    if (this.channelId === 'app-only') {
      // Public JSON API — no OAuth needed, append .json
      const jsonPath = path.includes('?')
        ? path.replace('?', '.json?')
        : `${path}.json`;
      const response = await fetch(`${REDDIT_PUBLIC_BASE}${jsonPath}`, {
        headers: { 'User-Agent': 'ShipFlare/1.0.0' },
      });
      if (response.status === 429 && !retried) {
        const waitSec = response.headers.get('retry-after');
        const waitMs = Math.min(waitSec ? parseInt(waitSec, 10) * 1000 : 5000, 5000);
        log.warn(`Reddit 429 on GET ${path}, short retry after ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.get(path, true);
      }
      if (response.status === 429) {
        throw new RateLimitError(`Reddit API rate limited on GET ${path}`);
      }
      if (!response.ok) {
        log.error(`Reddit GET ${path}: ${response.status}`);
        throw new Error(`Reddit API GET ${path}: ${response.status}`);
      }
      return response.json();
    }

    await this.ensureValidToken();
    const response = await fetch(`${REDDIT_OAUTH_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': 'ShipFlare/1.0.0',
      },
    });
    this.syncFromHeaders(response.headers);

    if (response.status === 429 && !retried) {
      const waitSec = response.headers.get('retry-after');
      const waitMs = Math.min(waitSec ? parseInt(waitSec, 10) * 1000 : 5000, 5000);
      log.warn(`Reddit 429 on GET ${path}, short retry after ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.get(path, true);
    }
    if (response.status === 429) {
      throw new RateLimitError(`Reddit API rate limited on GET ${path}`);
    }

    if (!response.ok) {
      log.error(`Reddit GET ${path}: ${response.status}`);
      throw new Error(`Reddit API GET ${path}: ${response.status}`);
    }

    return response.json();
  }

  private async post(
    path: string,
    body: Record<string, string>,
    retried = false,
  ): Promise<unknown> {
    await this.ensureValidToken();
    await this.rateLimitCheck();

    const response = await fetch(`${REDDIT_OAUTH_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'ShipFlare/1.0.0',
      },
      body: new URLSearchParams(body),
    });
    this.syncFromHeaders(response.headers);

    if (response.status === 429 && !retried) {
      const waitSec = response.headers.get('retry-after');
      const waitMs = Math.min(waitSec ? parseInt(waitSec, 10) * 1000 : 5000, 5000);
      log.warn(`Reddit 429 on POST ${path}, short retry after ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.post(path, body, true);
    }
    if (response.status === 429) {
      throw new RateLimitError(`Reddit API rate limited on POST ${path}`);
    }

    if (!response.ok) {
      log.error(`Reddit POST ${path}: ${response.status}`);
      throw new Error(`Reddit API POST ${path}: ${response.status}`);
    }

    return response.json();
  }
}
