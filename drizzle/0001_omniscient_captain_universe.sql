ALTER TYPE "public"."draft_status" ADD VALUE 'flagged';--> statement-breakpoint
ALTER TYPE "public"."draft_status" ADD VALUE 'needs_revision';--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "draft_type" text DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "post_title" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "review_verdict" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "review_score" real;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "review_json" jsonb;