ALTER TABLE "threads" ADD COLUMN "quoted_text" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "quoted_author" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "in_reply_to_text" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "in_reply_to_author" text;