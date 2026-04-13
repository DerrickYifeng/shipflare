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

// --- Rate limiting: 15-min windows for X API ---

const X_POST_RATE_LIMIT = 180; // 200/15min, leave buffer
const RATE_WINDOW_MS = 15 * 60_000; // 15 minutes

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
  };
}

/**
 * X (Twitter) API v2 client for posting tweets/replies.
 * Handles OAuth2 PKCE token management and rate limiting.
 * Search is handled by XAIClient (Grok), not this client.
 */
export class XClient {
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

  /**
   * Post a new tweet.
   */
  async postTweet(text: string): Promise<{ tweetId: string; url: string }> {
    if (text.length > 280) {
      throw new Error(`Tweet exceeds 280 characters (${text.length})`);
    }

    await this.ensureValidToken();
    this.rateLimitCheck();

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
    this.rateLimitCheck();

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
   * Get the authenticated user's profile.
   */
  async getMe(): Promise<{ id: string; username: string; name: string }> {
    await this.ensureValidToken();

    const response = await fetch(`${X_API_BASE}/users/me`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`X API /users/me failed: ${response.status}`);
    }

    const data = (await response.json()) as XUserResponse;
    return data.data;
  }

  // --- Token refresh ---

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

  // --- Rate limiting ---

  private rateLimitCheck(): void {
    const now = Date.now();
    if (now - this.windowStart > RATE_WINDOW_MS) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    if (this.requestCount >= X_POST_RATE_LIMIT) {
      const waitMs = RATE_WINDOW_MS - (now - this.windowStart);
      log.warn(`X rate limit exhausted, ${Math.ceil(waitMs / 1000)}s until reset`);
      throw new XRateLimitError(
        `X rate limit reached, resets in ${Math.ceil(waitMs / 1000)}s`,
      );
    }
    this.requestCount++;
  }

  // --- HTTP helpers ---

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
}
