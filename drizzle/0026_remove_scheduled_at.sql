-- Remove post scheduling: swap plan_items.scheduled_at for due_date (date)
-- + sort_order (integer). Dev DB only; existing rows discarded per spec.

ALTER TABLE "plan_items" DROP COLUMN "scheduled_at";
--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "due_date" date NOT NULL;
--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DROP INDEX IF EXISTS "plan_items_user_state_scheduled_idx";
--> statement-breakpoint
CREATE INDEX "plan_items_user_state_due_idx" ON "plan_items" ("user_id","state","due_date","sort_order");
