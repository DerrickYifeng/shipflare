CREATE TYPE "public"."todo_priority" AS ENUM('time_sensitive', 'scheduled', 'optional');--> statement-breakpoint
CREATE TYPE "public"."todo_source" AS ENUM('calendar', 'discovery', 'engagement');--> statement-breakpoint
CREATE TYPE "public"."todo_status" AS ENUM('pending', 'approved', 'skipped', 'expired');--> statement-breakpoint
CREATE TYPE "public"."todo_type" AS ENUM('approve_post', 'reply_thread', 'respond_engagement');--> statement-breakpoint
CREATE TABLE "todo_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"draft_id" text,
	"todo_type" "todo_type" NOT NULL,
	"source" "todo_source" NOT NULL,
	"priority" "todo_priority" DEFAULT 'optional' NOT NULL,
	"status" "todo_status" DEFAULT 'pending' NOT NULL,
	"title" text NOT NULL,
	"platform" text NOT NULL,
	"community" text,
	"external_url" text,
	"confidence" real,
	"scheduled_for" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"acted_at" timestamp,
	CONSTRAINT "todo_items_user_draft" UNIQUE("user_id","draft_id")
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"auto_approve_enabled" boolean DEFAULT false NOT NULL,
	"auto_approve_threshold" real DEFAULT 0.85 NOT NULL,
	"auto_approve_types" jsonb DEFAULT '["reply"]'::jsonb NOT NULL,
	"max_auto_approvals_per_day" integer DEFAULT 10 NOT NULL,
	"posting_hours_utc" jsonb DEFAULT '[14,17,21]'::jsonb NOT NULL,
	"content_mix_metric" integer DEFAULT 40 NOT NULL,
	"content_mix_educational" integer DEFAULT 30 NOT NULL,
	"content_mix_engagement" integer DEFAULT 20 NOT NULL,
	"content_mix_product" integer DEFAULT 10 NOT NULL,
	"notify_on_new_draft" boolean DEFAULT true NOT NULL,
	"notify_on_auto_approve" boolean DEFAULT true NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "x_analytics_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"best_content_types" jsonb NOT NULL,
	"best_posting_hours" jsonb NOT NULL,
	"audience_growth_rate" real DEFAULT 0 NOT NULL,
	"engagement_rate" real DEFAULT 0 NOT NULL,
	"total_impressions" integer DEFAULT 0 NOT NULL,
	"total_bookmarks" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "engagement_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_analytics_summary" ADD CONSTRAINT "x_analytics_summary_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;