-- drizzle-orm: always-run
--
-- Wave 2.3/3 cleanup:
--   - RENAME channels.post_history → post_history_deprecated_20260417
--     (superseded by channel_posts, 0016). Rename-first strategy preserves
--     data for a 60-90 day cooldown; a follow-up migration drops the column
--     after that window. Column is off-schema after 25fb5af so drizzle-kit
--     ignores it. Idempotent: if post_history is already absent (old DROP
--     applied locally), the DO block is a no-op.
--   - DROP activity_events_user_created_idx (superseded by
--     _user_type_created_idx, 0013). Indexes carry no data — trivially
--     recreatable; IF EXISTS guard makes this idempotent.
--
-- Destructive-op policy: prefer RENAME COLUMN over DROP COLUMN for a
-- cooldown period. Use _deprecated_YYYYMMDD suffix for discoverability.
-- Actual DROP goes in a follow-up migration after the cooldown window.
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'channels' AND column_name = 'post_history'
  ) THEN
    ALTER TABLE "channels"
      RENAME COLUMN "post_history" TO "post_history_deprecated_20260417";
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "activity_events_user_created_idx";
