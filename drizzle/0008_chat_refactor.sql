-- Chat refactor — ChatGPT-style first-class conversations.
--
-- Drops the Phase 2 "infer active conversation server-side" model.
-- The CLIENT now tracks focus and passes `conversationId` on every
-- send; the server never guesses. That makes `status`,
-- `last_turn_at`, and the partial-active unique index all obsolete.
--
-- `updated_at` replaces `last_turn_at` semantically and `started_at` is
-- renamed to `created_at` to match naming conventions across the rest
-- of the schema. The rename is done in-place (RENAME COLUMN) so
-- existing data is preserved.

-- Drop the partial-unique "one active per team" index — the concept
-- of an "active" conversation no longer exists at the schema layer.
DROP INDEX IF EXISTS "idx_team_conversations_one_active_per_team";

-- Drop the old recency index; we'll recreate it against the renamed
-- column below.
DROP INDEX IF EXISTS "idx_team_conversations_team_recent";

ALTER TABLE "team_conversations" DROP COLUMN IF EXISTS "status";

-- Rename started_at → created_at + last_turn_at → updated_at.
-- Preserves every row's timestamps verbatim.
ALTER TABLE "team_conversations" RENAME COLUMN "started_at" TO "created_at";
ALTER TABLE "team_conversations" RENAME COLUMN "last_turn_at" TO "updated_at";

CREATE INDEX "idx_team_conversations_team_recent"
  ON "team_conversations" ("team_id", "updated_at" DESC);
