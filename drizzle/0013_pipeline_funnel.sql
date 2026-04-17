-- Wave 3 Theme 6: Pipeline funnel telemetry + discovery feedback ground truth.
-- Two new tables:
--   pipeline_events — one row per stage transition (discovered → gate_passed
--                     → draft_created → reviewed → approved → posted →
--                     engaged / failed). Written from workers via
--                     recordPipelineEvent(); swallow-on-error so telemetry
--                     cannot break the main pipeline.
--   thread_feedback — per-user, per-thread disposition (skip | approve | post)
--                     used as ground truth for the discovery optimization
--                     loop. Unique on (user_id, thread_id) so re-labelling
--                     upserts cleanly.

CREATE TABLE IF NOT EXISTS "pipeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text,
	"stage" text NOT NULL,
	"thread_id" text,
	"draft_id" text,
	"post_id" text,
	"entered_at" timestamp DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"cost" double precision,
	"metadata" jsonb
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_events_user_stage_entered" ON "pipeline_events" USING btree ("user_id","stage","entered_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_events_user_entered" ON "pipeline_events" USING btree ("user_id","entered_at" desc);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "thread_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "thread_feedback" ADD CONSTRAINT "thread_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "thread_feedback" ADD CONSTRAINT "thread_feedback_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_feedback_user_thread_uq" ON "thread_feedback" USING btree ("user_id","thread_id");
