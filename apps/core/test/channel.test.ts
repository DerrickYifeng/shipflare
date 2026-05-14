import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encrypt, generateKey } from "@shipflare/crypto";
import { createDb, channels, user as userTable } from "@shipflare/db";
import { getChannel } from "../src/lib/channel";

/**
 * Contract tests for `getChannel(env, userId, platform)` — the sanctioned
 * reader of `channels.oauth_token_encrypted` (CLAUDE.md Security TODO §1).
 *
 * S5.0 covers the two essential behaviours:
 *   1. happy path — active channel returns a decrypted ChannelConnection
 *   2. status filter — revoked / missing rows return null
 *
 * Full coverage (revoked → null, error → null, refreshToken handling,
 * decrypt failure → null) lands at S10 integration when end-to-end OAuth
 * flow is wired. The point of S5.0's tests is to lock the contract shape
 * before XMcpAgent's tools (S5.1) start calling it.
 *
 * Encryption key: `.dev.vars` ships `CHANNEL_ENC_KEY=` (empty) so beforeAll
 * generates a fresh 32-byte AES key and threads it through a per-test env
 * clone. Production reads the real key from `wrangler secret put
 * CHANNEL_ENC_KEY`.
 *
 * D1 bootstrap: vitest-pool-workers gives us a fresh in-memory D1 binding,
 * but it does NOT auto-apply migrations from `packages/db/migrations/`.
 * We inline the minimal `user` + `channels` schema in `beforeAll` so the
 * test exercises real Drizzle queries against the real D1 driver. Full
 * migration-runner coverage lands at S10 integration.
 */

/**
 * Apply the subset of the D1 schema this test touches (`user` + `channels`).
 * Mirrors packages/db/migrations/001_initial.sql; keep in lock-step.
 */
async function applyTestD1Schema(): Promise<void> {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS user ( id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, name TEXT, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL )`,
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS channels ( id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, platform TEXT NOT NULL CHECK (platform IN ('x', 'reddit', 'linkedin', 'hackernews', 'discord')), externalUserId TEXT NOT NULL, username TEXT, oauthTokenEncrypted TEXT NOT NULL, oauthRefreshEncrypted TEXT, scope TEXT, connectedAt INTEGER NOT NULL, lastVerifiedAt INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')) )`,
  );
}

interface ChannelRow {
  id: string;
  userId: string;
  platform: "x" | "reddit" | "linkedin" | "hackernews" | "discord";
  externalUserId: string;
  username: string | null;
  oauthTokenEncrypted: string;
  oauthRefreshEncrypted: string | null;
  scope: string | null;
  connectedAt: Date;
  lastVerifiedAt: Date | null;
  status: "active" | "revoked" | "error";
}

async function seedUserAndChannel(
  userId: string,
  channel: Omit<ChannelRow, "id" | "userId">,
): Promise<void> {
  const db = createDb(env.DB);
  // Better Auth foreign-key requires a user row first. Generic email keeps
  // each row unique without colliding across tests.
  await db
    .insert(userTable)
    .values({
      id: userId,
      email: `${userId}@test.shipflare.io`,
      emailVerified: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    .onConflictDoNothing();
  await db
    .insert(channels)
    .values({
      id: `chan-${userId}-${channel.platform}`,
      userId,
      ...channel,
    })
    .onConflictDoNothing();
}

describe("getChannel — sanctioned token reader", () => {
  // `.dev.vars` ships `CHANNEL_ENC_KEY=` (empty) so test setup generates a
  // valid 32-byte AES-256 key + injects it into a per-test env clone. The
  // production-secret path is exercised at S10 integration; here we just
  // need a real key that the round-trip can use.
  let testEnv: typeof env;

  beforeAll(async () => {
    await applyTestD1Schema();
    const key = await generateKey();
    testEnv = { ...env, CHANNEL_ENC_KEY: key };
  });

  it("decrypts the active channel and returns ChannelConnection", async () => {
    const userId = "channel-test-user-happy";
    const accessTokenPlain = "x-access-token-12345";
    const refreshTokenPlain = "x-refresh-token-67890";

    const encAccess = await encrypt(
      accessTokenPlain,
      testEnv.CHANNEL_ENC_KEY,
    );
    const encRefresh = await encrypt(
      refreshTokenPlain,
      testEnv.CHANNEL_ENC_KEY,
    );

    await seedUserAndChannel(userId, {
      platform: "x",
      externalUserId: "x-uid-42",
      username: "happyuser",
      oauthTokenEncrypted: encAccess,
      oauthRefreshEncrypted: encRefresh,
      scope: "tweet.read tweet.write users.read",
      connectedAt: new Date(1000),
      lastVerifiedAt: null,
      status: "active",
    });

    const conn = await getChannel(testEnv, userId, "x");
    expect(conn).not.toBeNull();
    expect(conn!.accessToken).toBe(accessTokenPlain);
    expect(conn!.refreshToken).toBe(refreshTokenPlain);
    expect(conn!.externalUserId).toBe("x-uid-42");
    expect(conn!.username).toBe("happyuser");
    expect(conn!.scope).toBe("tweet.read tweet.write users.read");
  });

  it("returns null for missing rows AND for non-active status", async () => {
    // Missing row
    const noResult = await getChannel(testEnv, "nonexistent-user-xyz", "x");
    expect(noResult).toBeNull();

    // Seeded but revoked → still null (status filter)
    const userId = "channel-test-user-revoked";
    const encAccess = await encrypt("dead-token", testEnv.CHANNEL_ENC_KEY);
    await seedUserAndChannel(userId, {
      platform: "reddit",
      externalUserId: "r-uid-77",
      username: "revokeduser",
      oauthTokenEncrypted: encAccess,
      oauthRefreshEncrypted: null,
      scope: null,
      connectedAt: new Date(2000),
      lastVerifiedAt: null,
      status: "revoked",
    });

    const revokedResult = await getChannel(testEnv, userId, "reddit");
    expect(revokedResult).toBeNull();
  });
});
