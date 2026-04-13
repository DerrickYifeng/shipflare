ALTER TABLE "threads" RENAME COLUMN "subreddit" TO "community";--> statement-breakpoint
ALTER TABLE "posts" RENAME COLUMN "subreddit" TO "community";
