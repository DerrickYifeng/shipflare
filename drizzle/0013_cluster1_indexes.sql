-- drizzle-orm: nontransactional
-- Cluster 1 online index additions. All CREATE INDEX statements use CONCURRENTLY
-- so they acquire only ShareUpdateExclusiveLock (no table-level lock) and are
-- safe to run against live traffic without a maintenance window.
--
-- IMPORTANT — deploy path:
--   This migration MUST NOT be applied inside a transaction block.
--   The apply-pending-migrations.mjs script detects the nontransactional
--   directive and runs each statement outside sql.begin(), which is required
--   for CREATE INDEX CONCURRENTLY. Running via drizzle-kit migrate is also
--   safe — the nontransactional directive suppresses drizzle-kit's BEGIN wrapper.
--   Do NOT run this file with psql inside an explicit BEGIN...COMMIT block.
--
--   Emergency psql apply (if running manually):
--     psql "$DATABASE_URL" -f drizzle/0013_cluster1_indexes.sql
--
-- FAILURE RECOVERY:
--   If any CREATE INDEX CONCURRENTLY fails (lock conflict, cancellation, etc.),
--   Postgres leaves an INVALID index behind. The migration will not retry cleanly
--   until the invalid index is removed. Before retrying, run:
--     SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--     DROP INDEX CONCURRENTLY IF EXISTS <invalid_index_name>;
--   Then re-apply this migration.

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_user_idx"
  ON "sessions" USING btree ("userId");

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_user_idx"
  ON "products" USING btree ("user_id");

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "code_snapshots_user_idx"
  ON "code_snapshots" USING btree ("user_id");

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "pipeline_events_thread_entered_idx"
  ON "pipeline_events" USING btree ("thread_id", "entered_at" DESC);

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "pipeline_events_draft_entered_idx"
  ON "pipeline_events" USING btree ("draft_id", "entered_at" DESC);

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_events_user_type_created_idx"
  ON "activity_events" USING btree ("user_id", "event_type", "created_at" DESC);

--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "posts_user_community_posted_idx"
  ON "posts" USING btree ("user_id", "community", "posted_at" DESC);
