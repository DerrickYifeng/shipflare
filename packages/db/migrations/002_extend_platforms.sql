-- P2-E: extend channels.platform CHECK to include linkedin / hackernews / discord.
--
-- Why a recreate instead of a one-shot ALTER: SQLite cannot modify a CHECK
-- constraint in place. The canonical pattern is to (a) create a new table with
-- the desired constraint, (b) copy rows, (c) drop the old table, (d) rename.
-- Indexes belong to the table identity so they are dropped with `channels` and
-- re-created against `channels_new` after rename (sqlite_master treats indexes
-- on a renamed table as bound to the new name — we still recreate explicitly
-- for clarity and to keep this migration self-contained).
--
-- Destructive risk: zero. Phase 2 is pre-launch, the D1 instance is local /
-- staging only, and the SELECT-INSERT preserves every column 1:1. Once we have
-- real users the same pattern still works because SQLite holds an exclusive
-- transaction across the script (D1 wraps migrations in BEGIN/COMMIT).

CREATE TABLE IF NOT EXISTS "channels_new" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL CHECK ("platform" IN ('x', 'reddit', 'linkedin', 'hackernews', 'discord')),
  "externalUserId" TEXT NOT NULL,
  "username" TEXT,
  "oauthTokenEncrypted" TEXT NOT NULL,
  "oauthRefreshEncrypted" TEXT,
  "scope" TEXT,
  "connectedAt" INTEGER NOT NULL,
  "lastVerifiedAt" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'revoked', 'error'))
);

INSERT INTO "channels_new" (
  "id", "userId", "platform", "externalUserId", "username",
  "oauthTokenEncrypted", "oauthRefreshEncrypted", "scope",
  "connectedAt", "lastVerifiedAt", "status"
)
SELECT
  "id", "userId", "platform", "externalUserId", "username",
  "oauthTokenEncrypted", "oauthRefreshEncrypted", "scope",
  "connectedAt", "lastVerifiedAt", "status"
FROM "channels";

DROP TABLE "channels";
ALTER TABLE "channels_new" RENAME TO "channels";

-- Re-create the FK + lookup indexes that 001 attached to `channels`.
CREATE INDEX IF NOT EXISTS "channels_userId_idx" ON "channels"("userId");
CREATE INDEX IF NOT EXISTS "channels_userId_platform_idx" ON "channels"("userId", "platform");
