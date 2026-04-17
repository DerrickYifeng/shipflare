-- discovery_configs was previously created by a hand-written migration that
-- was never recorded in the drizzle journal; guard it with IF NOT EXISTS so
-- this migration is idempotent across environments that already ran the
-- orphan 0009_add_discovery_configs.sql.
CREATE TABLE IF NOT EXISTS "discovery_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text DEFAULT 'reddit' NOT NULL,
	"weight_relevance" real DEFAULT 0.3 NOT NULL,
	"weight_intent" real DEFAULT 0.45 NOT NULL,
	"weight_exposure" real DEFAULT 0.1 NOT NULL,
	"weight_freshness" real DEFAULT 0.1 NOT NULL,
	"weight_engagement" real DEFAULT 0.05 NOT NULL,
	"intent_gate" real DEFAULT 0.5 NOT NULL,
	"relevance_gate" real DEFAULT 0.5 NOT NULL,
	"gate_cap" real DEFAULT 0.45 NOT NULL,
	"enqueue_threshold" real DEFAULT 0.7 NOT NULL,
	"custom_pain_phrases" text[] DEFAULT '{}',
	"custom_query_templates" text[] DEFAULT '{}',
	"strategy_rules" text,
	"platform_strategy_override" text,
	"custom_low_relevance_patterns" text,
	"calibration_status" text DEFAULT 'pending' NOT NULL,
	"calibration_round" integer DEFAULT 0 NOT NULL,
	"calibration_precision" real,
	"calibration_log" jsonb,
	"optimization_version" integer DEFAULT 0 NOT NULL,
	"runs_since_optimization" integer DEFAULT 0 NOT NULL,
	"last_optimized_at" timestamp,
	"precision_at_optimization" real,
	"previous_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_configs_user_id_platform_unique" UNIQUE("user_id","platform")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "discovery_configs" ADD CONSTRAINT "discovery_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- posts.platform: 3-step add-column to avoid "column has null values" on
-- existing rows. Backfill from threads.platform via drafts.thread_id.
ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "platform" text;--> statement-breakpoint
UPDATE "posts" SET "platform" = (
  SELECT t."platform"
  FROM "threads" t
  JOIN "drafts" d ON d."thread_id" = t."id"
  WHERE d."id" = "posts"."draft_id"
  LIMIT 1
) WHERE "platform" IS NULL;--> statement-breakpoint
-- Fallback for any rows whose thread was deleted: treat as 'reddit' (the
-- historic default before this column existed).
UPDATE "posts" SET "platform" = 'reddit' WHERE "platform" IS NULL;--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "platform" SET NOT NULL;--> statement-breakpoint

-- x_follower_snapshots.snapshot_date: 3-step. Derive from snapshot_at (UTC day).
ALTER TABLE "x_follower_snapshots" ADD COLUMN IF NOT EXISTS "snapshot_date" date;--> statement-breakpoint
UPDATE "x_follower_snapshots"
  SET "snapshot_date" = ("snapshot_at" AT TIME ZONE 'UTC')::date
  WHERE "snapshot_date" IS NULL;--> statement-breakpoint
-- Collapse pre-existing duplicate per-day rows so the new unique index can be
-- created. Keep the earliest snapshot per (user_id, snapshot_date).
DELETE FROM "x_follower_snapshots" a USING "x_follower_snapshots" b
  WHERE a."user_id" = b."user_id"
    AND a."snapshot_date" = b."snapshot_date"
    AND a."snapshot_at" > b."snapshot_at";--> statement-breakpoint
ALTER TABLE "x_follower_snapshots" ALTER COLUMN "snapshot_date" SET NOT NULL;--> statement-breakpoint

-- Indexes. Production deploys should re-run each CREATE INDEX as
-- CREATE INDEX CONCURRENTLY against a paused worker to avoid long table locks
-- on threads/posts/activity_events. Drizzle cannot emit CONCURRENTLY inside a
-- transaction, so a manual staging step is required for large tables.
CREATE INDEX IF NOT EXISTS "accounts_user_idx" ON "accounts" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_events_user_created_idx" ON "activity_events" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "am_product_type_idx" ON "agent_memories" USING btree ("product_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aml_product_distilled_logged_idx" ON "agent_memory_logs" USING btree ("product_id","logged_at") WHERE distilled = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channels_user_platform_uq" ON "channels" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_user_status_created_idx" ON "drafts" USING btree ("user_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_scores_user_calculated_idx" ON "health_scores" USING btree ("user_id","calculated_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_user_posted_idx" ON "posts" USING btree ("user_id","posted_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "posts_platform_external_uq" ON "posts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_user_discovered_idx" ON "threads" USING btree ("user_id","discovered_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "threads_user_platform_external_uq" ON "threads" USING btree ("user_id","platform","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "todos_user_status_expires_idx" ON "todo_items" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xas_user_computed_idx" ON "x_analytics_summary" USING btree ("user_id","computed_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xcc_user_channel_status_scheduled_idx" ON "x_content_calendar" USING btree ("user_id","channel","status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "xfs_user_date_uq" ON "x_follower_snapshots" USING btree ("user_id","snapshot_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xmt_user_status_deadline_idx" ON "x_monitored_tweets" USING btree ("user_id","status","reply_deadline");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xtm_user_sampled_idx" ON "x_tweet_metrics" USING btree ("user_id","sampled_at" desc);
