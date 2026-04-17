import { decrypt, encrypt } from '@/lib/encryption';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:x');

const X_API_BASE = 'https://api.x.com/2';
const TOKEN_BUFFER_SECONDS = 300; // Refresh 5 min before expiry

/**
 * Thrown when the X API rate limit is exhausted.
 */
export class XRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XRateLimitError';
  }
}

/**
 * Thrown when the X API returns 403 (e.g. Free tier cannot access read endpoints).
 */
export class XForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XForbiddenError';
  }
}

// --- Rate limiting: per-endpoint 15-min windows ---

const RATE_WINDOW_MS = 15 * 60_000;

interface RateBucket {
  count: number;
  windowStart: number;
  limit: number;
}

// Cache entry with TTL
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

// --- Response types ---

interface XTweetResponse {
  data: {
    id: string;
    text: string;
  };
}

interface XUserResponse {
  data: {
    id: string;
    username: string;
    name: string;
    public_metrics?: {
      followers_count: number;
      following_count: number;
      tweet_count: number;
    };
  };
}

interface XTweetData {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{
    type: 'replied_to' | 'quoted' | 'retweeted';
    id: string;
  }>;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    bookmark_count: number;
    impression_count: number;
  };
}

interface XTweetExpanded {
  data: XTweetData;
  includes?: {
    users?: Array<{ id: string; username: string; name: string }>;
  };
}

interface XTweetsResponse {
  data?: XTweetData[];
  includes?: {
    users?: Array<{ id: string; username: string; name: string }>;
  };
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    result_count?: number;
    next_token?: string;
  };
}

export interface XTweetResult {
  id: string;
  text: string;
  authorId?: string;
  authorUsername?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  referencedTweets?: Array<{
    type: 'replied_to' | 'quoted' | 'retweeted';
    id: string;
  }>;
  metrics?: {
    retweets: number;
    replies: number;
    likes: number;
    quotes: number;
    bookmarks: number;
    impressions: number;
  };
}

/**
 * X (Twitter) API v2 client for posting tweets/replies and reading data.
 * Handles OAuth2 PKCE token management, per-endpoint rate limiting, and caching.
 * Search is handled by XAIClient (Grok), not this client.
 */
export class XClient {
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: Date;
  private channelId: string;

  // Per-endpoint rate limit buckets
  private rateBuckets: Map<string, RateBucket> = new Map();

  // Read cache
  private cache: Map<string, CacheEntry<unknown>> = new Map();

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
   * Create an XClient from a channel database record.
   */
  static fromChannel(channel: {
    id: string;
    oauthTokenEncrypted: string;
    refreshTokenEncrypted: string;
    tokenExpiresAt: Date | null;
  }): XClient {
    return new XClient(
      channel.id,
      channel.oauthTokenEncrypted,
      channel.refreshTokenEncrypted,
      channel.tokenExpiresAt,
    );
  }

  // ----------------------------------------------------------------
  //  WRITE endpoints
  // ----------------------------------------------------------------

  /**
   * Post a new tweet.
   */
  async postTweet(text: string): Promise<{ tweetId: string; url: string }> {
    if (text.length > 280) {
      throw new Error(`Tweet exceeds 280 characters (${text.length})`);
    }

    await this.ensureValidToken();
    this.checkRate('post_tweet', 180);

    const response = await this.post('/tweets', { text });
    const data = response as XTweetResponse;

    log.info(`Posted tweet ${data.data.id}`);
    return {
      tweetId: data.data.id,
      url: `https://x.com/i/status/${data.data.id}`,
    };
  }

  /**
   * Reply to an existing tweet.
   */
  async replyToTweet(
    tweetId: string,
    text: string,
  ): Promise<{ tweetId: string; url: string }> {
    if (text.length > 280) {
      throw new Error(`Reply exceeds 280 characters (${text.length})`);
    }

    await this.ensureValidToken();
    this.checkRate('post_tweet', 180);

    const response = await this.post('/tweets', {
      text,
      reply: { in_reply_to_tweet_id: tweetId },
    });
    const data = response as XTweetResponse;

    log.info(`Replied to tweet ${tweetId} with ${data.data.id}`);
    return {
      tweetId: data.data.id,
      url: `https://x.com/i/status/${data.data.id}`,
    };
  }

  /**
   * Post a multi-tweet thread (chain of replies to own tweets).
   */
  async postThread(
    tweets: string[],
  ): Promise<Array<{ tweetId: string; url: string }>> {
    if (tweets.length === 0) throw new Error('Thread must have at least one tweet');
    for (const [i, tweet] of tweets.entries()) {
      if (tweet.length > 280) {
        throw new Error(`Tweet ${i + 1} exceeds 280 characters (${tweet.length})`);
      }
    }

    const results: Array<{ tweetId: string; url: string }> = [];

    // First tweet is a standalone post
    const first = await this.postTweet(tweets[0]);
    results.push(first);

    // Subsequent tweets reply to the previous one
    for (let i = 1; i < tweets.length; i++) {
      const prev = results[i - 1];
      const reply = await this.replyToTweet(prev.tweetId, tweets[i]);
      results.push(reply);
    }

    log.info(`Posted thread of ${tweets.length} tweets`);
    return results;
  }

  // ----------------------------------------------------------------
  //  READ endpoints (require Basic tier $200/month)
  // ----------------------------------------------------------------

  private static readonly TWEET_FIELDS =
    'created_at,public_metrics,conversation_id,author_id,referenced_tweets,in_reply_to_user_id';
  private static readonly USER_FIELDS = 'username,name,public_metrics';

  /**
   * Get the authenticated user's profile.
   */
  async getMe(): Promise<{
    id: string;
    username: string;
    name: string;
    publicMetrics?: {
      followersCount: number;
      followingCount: number;
      tweetCount: number;
    };
  }> {
    await this.ensureValidToken();

    const data = await this.get<XUserResponse>('/users/me', {
      'user.fields': XClient.USER_FIELDS,
    });

    return {
      id: data.data.id,
      username: data.data.username,
      name: data.data.name,
      publicMetrics: data.data.public_metrics
        ? {
            followersCount: data.data.public_metrics.followers_count,
            followingCount: data.data.public_metrics.following_count,
            tweetCount: data.data.public_metrics.tweet_count,
          }
        : undefined,
    };
  }

  /**
   * Look up a user by username. Used to validate target accounts.
   */
  async lookupUser(username: string): Promise<{
    id: string;
    username: string;
    name: string;
    followersCount?: number;
  }> {
    await this.ensureValidToken();
    this.checkRate('get_users', 300);

    const cacheKey = `user:${username}`;
    const cached = this.getCached<XUserResponse>(cacheKey);
    if (cached) {
      return this.mapUserResponse(cached);
    }

    const data = await this.get<XUserResponse>(
      `/users/by/username/${username}`,
      { 'user.fields': XClient.USER_FIELDS },
    );

    this.setCache(cacheKey, data);
    return this.mapUserResponse(data);
  }

  /**
   * Fetch recent tweets from a specific user (for monitoring target accounts).
   */
  async getUserTweets(
    userId: string,
    opts: { sinceId?: string; maxResults?: number } = {},
  ): Promise<{ tweets: XTweetResult[]; newestId?: string }> {
    await this.ensureValidToken();
    this.checkRate('get_tweets', 300);

    const params: Record<string, string> = {
      'tweet.fields': XClient.TWEET_FIELDS,
      'user.fields': 'username',
      max_results: String(opts.maxResults ?? 10),
      expansions: 'author_id',
    };
    if (opts.sinceId) params.since_id = opts.sinceId;

    const data = await this.get<XTweetsResponse>(
      `/users/${userId}/tweets`,
      params,
    );

    const userMap = this.buildUserMap(data.includes?.users);
    const tweets = (data.data ?? []).map((t) =>
      this.mapTweetData(t, userMap),
    );

    return { tweets, newestId: data.meta?.newest_id };
  }

  /**
   * Fetch a single tweet by ID with full metadata.
   */
  async getTweet(tweetId: string): Promise<XTweetResult> {
    await this.ensureValidToken();
    this.checkRate('get_tweets', 300);

    const cacheKey = `tweet:${tweetId}`;
    const cached = this.getCached<XTweetExpanded>(cacheKey);
    if (cached) {
      const userMap = this.buildUserMap(cached.includes?.users);
      return this.mapTweetData(cached.data, userMap);
    }

    const data = await this.get<XTweetExpanded>(`/tweets/${tweetId}`, {
      'tweet.fields': XClient.TWEET_FIELDS,
      'user.fields': 'username',
      expansions: 'author_id',
    });

    this.setCache(cacheKey, data);
    const userMap = this.buildUserMap(data.includes?.users);
    return this.mapTweetData(data.data, userMap);
  }

  /**
   * Batch-fetch tweets by IDs (max 100 per call).
   */
  async getTweets(tweetIds: string[]): Promise<XTweetResult[]> {
    if (tweetIds.length === 0) return [];
    if (tweetIds.length > 100) {
      throw new Error('getTweets supports max 100 IDs per call');
    }

    await this.ensureValidToken();
    this.checkRate('get_tweets', 300);

    const data = await this.get<XTweetsResponse>('/tweets', {
      ids: tweetIds.join(','),
      'tweet.fields': XClient.TWEET_FIELDS,
      'user.fields': 'username',
      expansions: 'author_id',
    });

    const userMap = this.buildUserMap(data.includes?.users);
    return (data.data ?? []).map((t) => this.mapTweetData(t, userMap));
  }

  /**
   * Fetch mentions of the authenticated user (for post-publish engagement).
   */
  async getMentions(
    userId: string,
    opts: { sinceId?: string; maxResults?: number } = {},
  ): Promise<{ tweets: XTweetResult[]; newestId?: string }> {
    await this.ensureValidToken();
    this.checkRate('get_mentions', 180);

    const params: Record<string, string> = {
      'tweet.fields': XClient.TWEET_FIELDS,
      'user.fields': 'username',
      max_results: String(opts.maxResults ?? 10),
      expansions: 'author_id',
    };
    if (opts.sinceId) params.since_id = opts.sinceId;

    const data = await this.get<XTweetsResponse>(
      `/users/${userId}/mentions`,
      params,
    );

    const userMap = this.buildUserMap(data.includes?.users);
    const tweets = (data.data ?? []).map((t) =>
      this.mapTweetData(t, userMap),
    );

    return { tweets, newestId: data.meta?.newest_id };
  }

  // ----------------------------------------------------------------
  //  Token refresh
  // ----------------------------------------------------------------

  private async ensureValidToken(): Promise<void> {
    const now = new Date();
    const bufferDate = new Date(
      this.expiresAt.getTime() - TOKEN_BUFFER_SECONDS * 1000,
    );

    if (now < bufferDate) return;

    log.debug('Refreshing X OAuth token');

    const clientId = process.env.X_CLIENT_ID;
    const clientSecret = process.env.X_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('X_CLIENT_ID and X_CLIENT_SECRET are required for token refresh');
    }

    const response = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`X token refresh failed: ${response.status} ${errorText}`);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.accessToken = tokens.access_token;
    // X returns a new refresh token on each refresh (rotation)
    this.refreshToken = tokens.refresh_token;
    this.expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Persist encrypted tokens to DB
    await db
      .update(channels)
      .set({
        oauthTokenEncrypted: encrypt(this.accessToken),
        refreshTokenEncrypted: encrypt(this.refreshToken),
        tokenExpiresAt: this.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, this.channelId));
  }

  // ----------------------------------------------------------------
  //  Rate limiting (per-endpoint buckets)
  // ----------------------------------------------------------------

  private checkRate(endpoint: string, limit: number): void {
    const now = Date.now();
    let bucket = this.rateBuckets.get(endpoint);

    if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
      bucket = { count: 0, windowStart: now, limit };
      this.rateBuckets.set(endpoint, bucket);
    }

    if (bucket.count >= bucket.limit) {
      const waitMs = RATE_WINDOW_MS - (now - bucket.windowStart);
      log.warn(`X rate limit [${endpoint}] exhausted, ${Math.ceil(waitMs / 1000)}s until reset`);
      throw new XRateLimitError(
        `X rate limit [${endpoint}] reached, resets in ${Math.ceil(waitMs / 1000)}s`,
      );
    }

    bucket.count++;
  }

  // ----------------------------------------------------------------
  //  Cache
  // ----------------------------------------------------------------

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  // ----------------------------------------------------------------
  //  HTTP helpers
  // ----------------------------------------------------------------

  private async get<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${X_API_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (response.status === 429) {
      throw new XRateLimitError('X API rate limit (429)');
    }

    if (response.status === 403) {
      throw new XForbiddenError(
        `X API ${path} returned 403. This endpoint may require X Basic tier ($200/month). ` +
        'Free tier only supports posting and /users/me.',
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`X API GET ${path} failed: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${X_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new XRateLimitError('X API rate limit (429)');
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`X API ${path} failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  // ----------------------------------------------------------------
  //  Data mapping helpers
  // ----------------------------------------------------------------

  private mapUserResponse(data: XUserResponse): {
    id: string;
    username: string;
    name: string;
    followersCount?: number;
  } {
    return {
      id: data.data.id,
      username: data.data.username,
      name: data.data.name,
      followersCount: data.data.public_metrics?.followers_count,
    };
  }

  private buildUserMap(
    users?: Array<{ id: string; username: string; name: string }>,
  ): Map<string, string> {
    const map = new Map<string, string>();
    if (users) {
      for (const u of users) {
        map.set(u.id, u.username);
      }
    }
    return map;
  }

  private mapTweetData(
    t: XTweetData,
    userMap: Map<string, string>,
  ): XTweetResult {
    return {
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      authorUsername: t.author_id ? userMap.get(t.author_id) : undefined,
      createdAt: t.created_at,
      conversationId: t.conversation_id,
      inReplyToUserId: t.in_reply_to_user_id,
      referencedTweets: t.referenced_tweets,
      metrics: t.public_metrics
        ? {
            retweets: t.public_metrics.retweet_count,
            replies: t.public_metrics.reply_count,
            likes: t.public_metrics.like_count,
            quotes: t.public_metrics.quote_count,
            bookmarks: t.public_metrics.bookmark_count,
            impressions: t.public_metrics.impression_count,
          }
        : undefined,
    };
  }
}
