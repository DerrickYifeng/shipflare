/**
 * channels schema — token columns must be nullable (handoff mode).
 *
 * Reddit handoff-mode channels carry a username (the founder's reddit
 * handle, used for footprint scans + author cooldown) but no OAuth
 * token (Reddit clients always go through `RedditClient.appOnly()`).
 * Both `oauthTokenEncrypted` and `refreshTokenEncrypted` therefore must
 * accept NULL at the schema level.
 *
 * Runtime check: the Drizzle column metadata exposes `.notNull` so we
 * can assert the schema definition directly without round-tripping
 * through Postgres. A future migration that re-adds `.notNull()` to
 * either column flips this test red.
 *
 * Type check: the inserted-row type below uses `null` literals for
 * both token columns; `pnpm tsc --noEmit` rejects the file if either
 * column is reverted to `.notNull()`.
 */
import { describe, it, expect } from 'vitest';
import { channels } from '@/lib/db/schema';

describe('channels schema — nullable tokens (handoff mode)', () => {
  it('declares oauth_token_encrypted as nullable', () => {
    expect(channels.oauthTokenEncrypted.notNull).toBe(false);
  });

  it('declares refresh_token_encrypted as nullable', () => {
    expect(channels.refreshTokenEncrypted.notNull).toBe(false);
  });

  it('still requires user_id, platform, and username', () => {
    expect(channels.userId.notNull).toBe(true);
    expect(channels.platform.notNull).toBe(true);
    expect(channels.username.notNull).toBe(true);
  });

  it('accepts null tokens in the inferred insert type', () => {
    // Compile-time guard: this object must satisfy `typeof channels.$inferInsert`.
    // If either token column is reverted to `.notNull()`, `tsc --noEmit`
    // rejects this file with "Type 'null' is not assignable...".
    const handoffRow: typeof channels.$inferInsert = {
      userId: 'test-user',
      platform: 'reddit',
      username: 'shipflare-test-2026',
      oauthTokenEncrypted: null,
      refreshTokenEncrypted: null,
    };
    expect(handoffRow.oauthTokenEncrypted).toBeNull();
    expect(handoffRow.refreshTokenEncrypted).toBeNull();
  });

  it('still accepts non-null tokens (X / connected reddit channels)', () => {
    const connectedRow: typeof channels.$inferInsert = {
      userId: 'test-user',
      platform: 'x',
      username: 'foo',
      oauthTokenEncrypted: 'enc:xxxxx',
      refreshTokenEncrypted: 'enc:yyyyy',
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
    };
    expect(connectedRow.oauthTokenEncrypted).toBe('enc:xxxxx');
  });
});
