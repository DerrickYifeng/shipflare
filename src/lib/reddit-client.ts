import { decrypt, encrypt } from '@/lib/encryption';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const REDDIT_API_BASE = 'https://oauth.reddit.com';
const TOKEN_BUFFER_SECONDS = 300; // Refresh 5 min before expiry

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
   * Search a subreddit for threads matching a query.
   */
  async searchSubreddit(
    subreddit: string,
    query: string,
    limit = 10,
  ): Promise<RedditThread[]> {
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
    return listing.data.children.map((c) => c.data);
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

    // Refresh the token
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
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    if (this.requestCount >= 55) {
      // Leave buffer below 60/min limit
      const waitMs = 60_000 - (now - this.windowStart);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    this.requestCount++;
  }

  private async get(path: string): Promise<unknown> {
    await this.ensureValidToken();
    await this.rateLimitCheck();

    const response = await fetch(`${REDDIT_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': 'ShipFlare/1.0.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Reddit API GET ${path}: ${response.status}`);
    }

    return response.json();
  }

  private async post(
    path: string,
    body: Record<string, string>,
  ): Promise<unknown> {
    await this.ensureValidToken();
    await this.rateLimitCheck();

    const response = await fetch(`${REDDIT_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'ShipFlare/1.0.0',
      },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      throw new Error(`Reddit API POST ${path}: ${response.status}`);
    }

    return response.json();
  }
}
