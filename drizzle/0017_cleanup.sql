-- drizzle-orm: always-run
--
-- Wave 2.3/3 cleanup:
--   - DROP channels.post_history (superseded by channel_posts, 0016)
--   - DROP activity_events_user_created_idx (superseded by _user_type_created_idx, 0013)
-- Both guarded with IF EXISTS; idempotent.
--> statement-breakpoint

ALTER TABLE "channels" DROP COLUMN IF EXISTS "post_history";
--> statement-breakpoint

DROP INDEX IF EXISTS "activity_events_user_created_idx";
