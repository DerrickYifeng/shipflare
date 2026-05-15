-- D1 (SQLite) migration: Better Auth's 4 required tables + ShipFlare's
-- `channels` table. Hand-written to match packages/db/src/schema.ts and to
-- include the explicit FK indexes drizzle-kit does not always emit.
--
-- Column names are camelCase to match @better-auth/drizzle-adapter's
-- expected identifiers (Phase 0 spike #4). Integer timestamps are stored as
-- Unix epoch milliseconds to match Drizzle's `mode: "timestamp_ms"` mapping.
--
-- Keep this SQL in lock-step with src/schema.ts.

-- ─── Better Auth 4 tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "name" TEXT,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);

-- ─── ShipFlare-specific ────────────────────────────────────────────────────
-- D1 doesn't enforce Drizzle's enum tag at the SQL layer, so we re-encode the
-- enum constraints as CHECKs here.

CREATE TABLE IF NOT EXISTS "channels" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL CHECK ("platform" IN ('x', 'reddit')),
  "externalUserId" TEXT NOT NULL,
  "username" TEXT,
  "oauthTokenEncrypted" TEXT NOT NULL,
  "oauthRefreshEncrypted" TEXT,
  "scope" TEXT,
  "connectedAt" INTEGER NOT NULL,
  "lastVerifiedAt" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error'))
);

-- ─── Indexes ───────────────────────────────────────────────────────────────
-- Phase 0 spike #4 review: SQLite doesn't auto-index FK columns. Add explicit
-- indexes for session.userId, account.userId, channels.userId, and the
-- (userId, platform) lookup that's hot for "fetch my X channel".

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
CREATE INDEX IF NOT EXISTS "channels_userId_idx" ON "channels"("userId");
CREATE INDEX IF NOT EXISTS "channels_userId_platform_idx" ON "channels"("userId", "platform");
