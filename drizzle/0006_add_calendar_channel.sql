ALTER TABLE "x_content_calendar" ADD COLUMN "channel" text DEFAULT 'x' NOT NULL;--> statement-breakpoint
ALTER TABLE "x_content_calendar" RENAME COLUMN "posted_tweet_id" TO "posted_external_id";
