CREATE TYPE "public"."launch_phase" AS ENUM('foundation', 'audience', 'momentum', 'launch', 'compound', 'steady');--> statement-breakpoint
CREATE TYPE "public"."plan_item_kind" AS ENUM('content_post', 'content_reply', 'email_send', 'interview', 'setup_task', 'launch_asset', 'runsheet_beat', 'metrics_compute', 'analytics_summary');--> statement-breakpoint
CREATE TYPE "public"."plan_item_state" AS ENUM('planned', 'drafted', 'ready_for_review', 'approved', 'executing', 'completed', 'skipped', 'failed', 'superseded', 'stale');--> statement-breakpoint
CREATE TYPE "public"."plan_item_user_action" AS ENUM('auto', 'approve', 'manual');--> statement-breakpoint
CREATE TYPE "public"."plan_trigger" AS ENUM('onboarding', 'weekly', 'manual');--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"kind" "plan_item_kind" NOT NULL,
	"state" "plan_item_state" DEFAULT 'planned' NOT NULL,
	"user_action" "plan_item_user_action" NOT NULL,
	"phase" "launch_phase" NOT NULL,
	"channel" text,
	"scheduled_at" timestamp NOT NULL,
	"skill_name" text,
	"params" jsonb NOT NULL,
	"output" jsonb,
	"title" text NOT NULL,
	"description" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"strategic_path_id" text,
	"trigger" "plan_trigger" NOT NULL,
	"week_start" timestamp NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	"usage_summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "strategic_paths" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"phase" "launch_phase" NOT NULL,
	"launch_date" timestamp,
	"launched_at" timestamp,
	"narrative" text NOT NULL,
	"milestones" jsonb NOT NULL,
	"thesis_arc" jsonb NOT NULL,
	"content_pillars" jsonb NOT NULL,
	"channel_mix" jsonb NOT NULL,
	"phase_goals" jsonb NOT NULL,
	"usage_summary" jsonb
);
--> statement-breakpoint
ALTER TABLE "x_content_calendar" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "todo_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weekly_themes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "x_content_calendar" CASCADE;--> statement-breakpoint
DROP TABLE "todo_items" CASCADE;--> statement-breakpoint
DROP TABLE "weekly_themes" CASCADE;--> statement-breakpoint
DROP INDEX "products_user_idx";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "state" text DEFAULT 'mvp' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "launch_date" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "launched_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "target_audience" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "onboarding_completed_at" timestamp;--> statement-breakpoint
-- Backfill state from legacy lifecycle_phase (dev-only best-effort mapping)
UPDATE "products" SET "state" = 'mvp'
  WHERE "lifecycle_phase" = 'pre_launch';--> statement-breakpoint
UPDATE "products"
  SET "state" = 'launched', "launched_at" = "created_at"
  WHERE "lifecycle_phase" IN ('launched', 'scaling');--> statement-breakpoint
-- Mark all existing products as having completed the old onboarding flow
UPDATE "products"
  SET "onboarding_completed_at" = "created_at"
  WHERE "onboarding_completed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_strategic_path_id_strategic_paths_id_fk" FOREIGN KEY ("strategic_path_id") REFERENCES "public"."strategic_paths"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_paths" ADD CONSTRAINT "strategic_paths_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategic_paths" ADD CONSTRAINT "strategic_paths_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_items_user_state_scheduled_idx" ON "plan_items" USING btree ("user_id","state","scheduled_at");--> statement-breakpoint
CREATE INDEX "plan_items_plan_idx" ON "plan_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "plan_items_user_kind_state_idx" ON "plan_items" USING btree ("user_id","kind","state");--> statement-breakpoint
CREATE INDEX "plans_user_week_idx" ON "plans" USING btree ("user_id","week_start" desc);--> statement-breakpoint
CREATE INDEX "plans_product_idx" ON "plans" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategic_paths_active_uq" ON "strategic_paths" USING btree ("user_id") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "strategic_paths_user_idx" ON "strategic_paths" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "strategic_paths_product_idx" ON "strategic_paths" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_user_uq" ON "products" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "lifecycle_phase";--> statement-breakpoint
DROP TYPE "public"."todo_priority";--> statement-breakpoint
DROP TYPE "public"."todo_source";--> statement-breakpoint
DROP TYPE "public"."todo_status";--> statement-breakpoint
DROP TYPE "public"."todo_type";--> statement-breakpoint
DROP TYPE "public"."x_content_calendar_status";
