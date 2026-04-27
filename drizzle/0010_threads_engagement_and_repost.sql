ALTER TABLE "threads" ADD COLUMN "likes_count" integer;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "reposts_count" integer;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "replies_count" integer;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "views_count" integer;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "is_repost" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "original_url" text;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "original_author_username" text;
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "surfaced_via" jsonb;
