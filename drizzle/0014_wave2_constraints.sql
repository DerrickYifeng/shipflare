-- drizzle-orm: always-run
--
-- Wave 2.1 — constraints, enums, and partial unique indexes.
-- All statements are idempotent (information_schema / pg_constraint guards).
-- Runs unconditionally inside a transaction on every env missing this hash.
--
-- Sub-changes:
--   C3  posts: partial unique (platform, external_id) WHERE external_id IS NOT NULL
--   H4  user_preferences: CHECK content_mix_metric + educational + engagement + product = 100
--   H5a x_monitored_tweets.status → x_monitored_tweet_status enum
--   H5b x_content_calendar.status → x_content_calendar_status enum
--   H6a todo_items: partial unique (user_id, draft_id) WHERE draft_id IS NOT NULL
--   H6b todo_items.draft_id FK: NO ACTION → ON DELETE SET NULL
--   N4a DESTRUCTIVE: delete duplicate x_analytics_summary rows, keep newest per period
--   N4b x_analytics_summary: UNIQUE (user_id, period_start, period_end)

--> statement-breakpoint
-- C3: drop old full unique (treats NULLs as distinct, not enforced); replace with partial
DROP INDEX IF EXISTS "posts_platform_external_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "posts_platform_external_uq"
  ON "posts" ("platform", "external_id")
  WHERE "external_id" IS NOT NULL;

--> statement-breakpoint
-- H4: content_mix columns must sum to 100
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_content_mix_sum'
  ) THEN
    ALTER TABLE "user_preferences"
      ADD CONSTRAINT "user_preferences_content_mix_sum"
      CHECK (
        content_mix_metric + content_mix_educational +
        content_mix_engagement + content_mix_product = 100
      );
  END IF;
END $$;

--> statement-breakpoint
-- H5a: create x_monitored_tweet_status enum (no-op if already exists)
DO $$ BEGIN
  CREATE TYPE "x_monitored_tweet_status" AS ENUM (
    'pending', 'draft_created', 'replied', 'skipped', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- H5a: convert x_monitored_tweets.status from text to enum (no-op if already enum)
DO $$ BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'x_monitored_tweets' AND column_name = 'status'
  ) = 'text' THEN
    ALTER TABLE "x_monitored_tweets"
      ALTER COLUMN "status" TYPE "x_monitored_tweet_status"
      USING "status"::"x_monitored_tweet_status";
  END IF;
END $$;

--> statement-breakpoint
-- H5b: create x_content_calendar_status enum (no-op if already exists)
DO $$ BEGIN
  CREATE TYPE "x_content_calendar_status" AS ENUM (
    'scheduled', 'draft_created', 'approved', 'posted', 'skipped'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- H5b: convert x_content_calendar.status from text to enum (no-op if already enum)
DO $$ BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'x_content_calendar' AND column_name = 'status'
  ) = 'text' THEN
    ALTER TABLE "x_content_calendar"
      ALTER COLUMN "status" TYPE "x_content_calendar_status"
      USING "status"::"x_content_calendar_status";
  END IF;
END $$;

--> statement-breakpoint
-- H6a: drop full unique (NULLs not excluded), replace with partial unique
ALTER TABLE "todo_items" DROP CONSTRAINT IF EXISTS "todo_items_user_draft";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "todo_items_user_draft_partial_uq"
  ON "todo_items" ("user_id", "draft_id")
  WHERE "draft_id" IS NOT NULL;

--> statement-breakpoint
-- H6b: change draft_id FK to ON DELETE SET NULL (no-op if already SET NULL)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'todo_items_draft_id_drafts_id_fk'
      AND confdeltype != 'n'
  ) THEN
    ALTER TABLE "todo_items" DROP CONSTRAINT "todo_items_draft_id_drafts_id_fk";
    ALTER TABLE "todo_items"
      ADD CONSTRAINT "todo_items_draft_id_drafts_id_fk"
      FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

--> statement-breakpoint
-- N4a: deduplicate x_analytics_summary before adding unique constraint.
-- Keeps the row with the highest id (most recently inserted) per (user_id, period_start, period_end).
-- DESTRUCTIVE: deletes older duplicate rows. No-op when no duplicates exist.
DELETE FROM "x_analytics_summary" a
USING "x_analytics_summary" b
WHERE a.id < b.id
  AND a.user_id = b.user_id
  AND a.period_start = b.period_start
  AND a.period_end = b.period_end;
--> statement-breakpoint
-- N4b: unique index (safe after N4a dedupe)
CREATE UNIQUE INDEX IF NOT EXISTS "xas_user_period_uq"
  ON "x_analytics_summary" ("user_id", "period_start", "period_end");
