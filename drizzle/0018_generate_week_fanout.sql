CREATE TYPE "public"."x_content_calendar_item_state" AS ENUM('queued', 'drafting', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD COLUMN "state" "x_content_calendar_item_state" DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD COLUMN "last_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "state" "x_content_calendar_item_state" DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "last_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "source_job_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xcc_user_state_scheduled_idx"
  ON "x_content_calendar" ("user_id", "state", "scheduled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "xcc_state_last_attempt_idx"
  ON "x_content_calendar" ("state", "last_attempt_at")
  WHERE "state" IN ('drafting','failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_user_state_idx"
  ON "threads" ("user_id", "state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_state_last_attempt_idx"
  ON "threads" ("state", "last_attempt_at")
  WHERE "state" IN ('drafting','failed');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_source_job_idx"
  ON "threads" ("source_job_id");
