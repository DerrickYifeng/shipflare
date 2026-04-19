CREATE TYPE "public"."draft_status" AS ENUM('pending', 'approved', 'skipped', 'posted', 'failed', 'flagged', 'needs_revision');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('posted', 'removed', 'verified');--> statement-breakpoint
CREATE TYPE "public"."todo_priority" AS ENUM('time_sensitive', 'scheduled', 'optional');--> statement-breakpoint
CREATE TYPE "public"."todo_source" AS ENUM('calendar', 'discovery', 'engagement');--> statement-breakpoint
CREATE TYPE "public"."todo_status" AS ENUM('pending', 'approved', 'skipped', 'expired');--> statement-breakpoint
CREATE TYPE "public"."todo_type" AS ENUM('approve_post', 'reply_thread', 'respond_engagement');--> statement-breakpoint
CREATE TYPE "public"."x_content_calendar_item_state" AS ENUM('queued', 'drafting', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."x_content_calendar_status" AS ENUM('scheduled', 'draft_created', 'approved', 'posted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."x_monitored_tweet_status" AS ENUM('pending', 'draft_created', 'replied', 'skipped', 'expired');--> statement-breakpoint
CREATE TABLE "accounts" (
	"userId" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"providerAccountId" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_providerAccountId_pk" PRIMARY KEY("provider","providerAccountId")
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"metadata_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memories_product_name_unique" UNIQUE("product_id","name")
);
--> statement-breakpoint
CREATE TABLE "agent_memory_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"entry" text NOT NULL,
	"logged_at" timestamp DEFAULT now() NOT NULL,
	"distilled" boolean DEFAULT false NOT NULL
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
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text DEFAULT 'reddit' NOT NULL,
	"username" text NOT NULL,
	"oauth_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"token_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo_url" text NOT NULL,
	"tech_stack" jsonb NOT NULL,
	"file_tree" jsonb NOT NULL,
	"key_files" jsonb NOT NULL,
	"scan_summary" text,
	"commit_sha" text,
	"diff_summary" text,
	"changes_detected" boolean DEFAULT false,
	"last_diff_at" timestamp,
	"scanned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "code_snapshots_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "x_content_calendar" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"channel" text DEFAULT 'x' NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"content_type" text NOT NULL,
	"status" "x_content_calendar_status" DEFAULT 'scheduled' NOT NULL,
	"topic" text,
	"draft_id" text,
	"posted_external_id" text,
	"state" "x_content_calendar_item_state" DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"angle" text,
	"theme_id" text,
	"is_white_space" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text DEFAULT 'reddit' NOT NULL,
	"weight_relevance" real DEFAULT 0.3 NOT NULL,
	"weight_intent" real DEFAULT 0.45 NOT NULL,
	"weight_exposure" real DEFAULT 0.1 NOT NULL,
	"weight_freshness" real DEFAULT 0.1 NOT NULL,
	"weight_engagement" real DEFAULT 0.05 NOT NULL,
	"intent_gate" real DEFAULT 0.5 NOT NULL,
	"relevance_gate" real DEFAULT 0.5 NOT NULL,
	"gate_cap" real DEFAULT 0.45 NOT NULL,
	"enqueue_threshold" real DEFAULT 0.7 NOT NULL,
	"custom_pain_phrases" text[] DEFAULT '{}',
	"custom_query_templates" text[] DEFAULT '{}',
	"strategy_rules" text,
	"platform_strategy_override" text,
	"custom_low_relevance_patterns" text,
	"calibration_status" text DEFAULT 'pending' NOT NULL,
	"calibration_round" integer DEFAULT 0 NOT NULL,
	"calibration_precision" real,
	"calibration_log" jsonb,
	"optimization_version" integer DEFAULT 0 NOT NULL,
	"runs_since_optimization" integer DEFAULT 0 NOT NULL,
	"last_optimized_at" timestamp,
	"precision_at_optimization" real,
	"previous_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_configs_user_id_platform_unique" UNIQUE("user_id","platform")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" "draft_status" DEFAULT 'pending' NOT NULL,
	"draft_type" text DEFAULT 'reply' NOT NULL,
	"post_title" text,
	"reply_body" text NOT NULL,
	"confidence_score" real NOT NULL,
	"why_it_works" text,
	"ftc_disclosure" text,
	"review_verdict" text,
	"review_score" real,
	"review_json" jsonb,
	"engagement_depth" integer DEFAULT 0 NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"score" integer NOT NULL,
	"s1_pipeline" real NOT NULL,
	"s2_quality" real NOT NULL,
	"s3_engagement" real NOT NULL,
	"s4_consistency" real NOT NULL,
	"s5_safety" real NOT NULL,
	"calculated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_monitored_tweets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"target_account_id" text NOT NULL,
	"tweet_id" text NOT NULL,
	"tweet_text" text NOT NULL,
	"author_username" text NOT NULL,
	"tweet_url" text NOT NULL,
	"posted_at" timestamp NOT NULL,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"reply_deadline" timestamp NOT NULL,
	"status" "x_monitored_tweet_status" DEFAULT 'pending' NOT NULL,
	CONSTRAINT "x_monitored_tweets_user_tweet" UNIQUE("user_id","tweet_id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_events" (
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
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"status" "post_status" DEFAULT 'posted' NOT NULL,
	"external_id" text,
	"external_url" text,
	"community" text NOT NULL,
	"posted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"url" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"keywords" text[] DEFAULT '{}' NOT NULL,
	"value_prop" text,
	"lifecycle_phase" text DEFAULT 'pre_launch' NOT NULL,
	"seo_audit_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sessionToken" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_target_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"x_user_id" text,
	"follower_count" integer,
	"priority" integer DEFAULT 1 NOT NULL,
	"category" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "x_target_accounts_user_username" UNIQUE("user_id","username")
);
--> statement-breakpoint
CREATE TABLE "thread_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"external_id" text NOT NULL,
	"platform" text DEFAULT 'reddit' NOT NULL,
	"community" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"body" text,
	"author" text,
	"upvotes" integer DEFAULT 0,
	"comment_count" integer DEFAULT 0,
	"relevance_score" real NOT NULL,
	"is_locked" boolean DEFAULT false,
	"is_archived" boolean DEFAULT false,
	"posted_at" timestamp,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"state" "x_content_calendar_item_state" DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"source_job_id" text
);
--> statement-breakpoint
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
	"acted_at" timestamp
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
	CONSTRAINT "user_preferences_user_id" UNIQUE("user_id"),
	CONSTRAINT "user_preferences_content_mix_sum" CHECK ("user_preferences"."content_mix_metric" + "user_preferences"."content_mix_educational" + "user_preferences"."content_mix_engagement" + "user_preferences"."content_mix_product" = 100)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"emailVerified" timestamp,
	"image" text,
	"github_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "x_follower_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"follower_count" integer NOT NULL,
	"following_count" integer NOT NULL,
	"tweet_count" integer NOT NULL,
	"snapshot_date" date NOT NULL,
	"snapshot_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_tweet_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tweet_id" text NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"retweets" integer DEFAULT 0 NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	"bookmarks" integer DEFAULT 0 NOT NULL,
	"quote_tweets" integer DEFAULT 0 NOT NULL,
	"url_clicks" integer DEFAULT 0 NOT NULL,
	"profile_clicks" integer DEFAULT 0 NOT NULL,
	"sampled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_themes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"channel" text NOT NULL,
	"week_start" timestamp NOT NULL,
	"thesis" text NOT NULL,
	"pillar" text,
	"thesis_source" text NOT NULL,
	"fallback_mode" text,
	"milestone_context" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_themes_user_channel_week" UNIQUE("user_id","channel","week_start")
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"register" text DEFAULT 'builder_log' NOT NULL,
	"pronouns" text DEFAULT 'i' NOT NULL,
	"capitalization" text DEFAULT 'sentence' NOT NULL,
	"emoji_policy" text DEFAULT 'sparing' NOT NULL,
	"signature_emoji" text,
	"punctuation_signatures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"humor_register" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"worldview_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opener_preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closer_policy" text DEFAULT 'silent_stop' NOT NULL,
	"voice_strength" text DEFAULT 'moderate' NOT NULL,
	"extracted_style_card_md" text,
	"sample_tweets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avg_sentence_length" real,
	"opener_histogram" jsonb DEFAULT '{}'::jsonb,
	"length_histogram" jsonb DEFAULT '{}'::jsonb,
	"extraction_version" integer DEFAULT 0 NOT NULL,
	"last_extracted_at" timestamp,
	"style_card_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profiles_user_channel" UNIQUE("user_id","channel")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_logs" ADD CONSTRAINT "agent_memory_logs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_analytics_summary" ADD CONSTRAINT "x_analytics_summary_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_snapshots" ADD CONSTRAINT "code_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_snapshots" ADD CONSTRAINT "code_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_theme_id_weekly_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."weekly_themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_configs" ADD CONSTRAINT "discovery_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_scores" ADD CONSTRAINT "health_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_monitored_tweets" ADD CONSTRAINT "x_monitored_tweets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_monitored_tweets" ADD CONSTRAINT "x_monitored_tweets_target_account_id_x_target_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."x_target_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_events" ADD CONSTRAINT "pipeline_events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_target_accounts" ADD CONSTRAINT "x_target_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_feedback" ADD CONSTRAINT "thread_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_feedback" ADD CONSTRAINT "thread_feedback_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_items" ADD CONSTRAINT "todo_items_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_follower_snapshots" ADD CONSTRAINT "x_follower_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_tweet_metrics" ADD CONSTRAINT "x_tweet_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_themes" ADD CONSTRAINT "weekly_themes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_themes" ADD CONSTRAINT "weekly_themes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "activity_events_user_type_created_idx" ON "activity_events" USING btree ("user_id","event_type","created_at" desc);--> statement-breakpoint
CREATE INDEX "am_product_type_idx" ON "agent_memories" USING btree ("product_id","type");--> statement-breakpoint
CREATE INDEX "agent_memories_user_idx" ON "agent_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "aml_product_distilled_logged_idx" ON "agent_memory_logs" USING btree ("product_id","logged_at") WHERE distilled = false;--> statement-breakpoint
CREATE INDEX "xas_user_computed_idx" ON "x_analytics_summary" USING btree ("user_id","computed_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "xas_user_period_uq" ON "x_analytics_summary" USING btree ("user_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_user_platform_uq" ON "channels" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "code_snapshots_user_idx" ON "code_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "xcc_user_channel_status_scheduled_idx" ON "x_content_calendar" USING btree ("user_id","channel","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "xcc_theme_idx" ON "x_content_calendar" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX "drafts_user_status_created_idx" ON "drafts" USING btree ("user_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "health_scores_user_calculated_idx" ON "health_scores" USING btree ("user_id","calculated_at" desc);--> statement-breakpoint
CREATE INDEX "xmt_user_status_deadline_idx" ON "x_monitored_tweets" USING btree ("user_id","status","reply_deadline");--> statement-breakpoint
CREATE INDEX "pipeline_events_user_stage_entered" ON "pipeline_events" USING btree ("user_id","stage","entered_at" desc);--> statement-breakpoint
CREATE INDEX "pipeline_events_user_entered" ON "pipeline_events" USING btree ("user_id","entered_at" desc);--> statement-breakpoint
CREATE INDEX "pipeline_events_thread_entered_idx" ON "pipeline_events" USING btree ("thread_id","entered_at" desc);--> statement-breakpoint
CREATE INDEX "pipeline_events_draft_entered_idx" ON "pipeline_events" USING btree ("draft_id","entered_at" desc);--> statement-breakpoint
CREATE INDEX "posts_user_posted_idx" ON "posts" USING btree ("user_id","posted_at" desc);--> statement-breakpoint
CREATE INDEX "posts_user_community_posted_idx" ON "posts" USING btree ("user_id","community","posted_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "posts_platform_external_uq" ON "posts" USING btree ("platform","external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "products_user_idx" ON "products" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_feedback_user_thread_uq" ON "thread_feedback" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "threads_user_discovered_idx" ON "threads" USING btree ("user_id","discovered_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "threads_user_platform_external_uq" ON "threads" USING btree ("user_id","platform","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "todo_items_user_draft_partial_uq" ON "todo_items" USING btree ("user_id","draft_id") WHERE "draft_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "todos_user_status_expires_idx" ON "todo_items" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "xfs_user_date_uq" ON "x_follower_snapshots" USING btree ("user_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "x_tweet_metrics_user_tweet" ON "x_tweet_metrics" USING btree ("user_id","tweet_id");--> statement-breakpoint
CREATE INDEX "xtm_user_sampled_idx" ON "x_tweet_metrics" USING btree ("user_id","sampled_at" desc);--> statement-breakpoint
CREATE INDEX "weekly_themes_user_channel_idx" ON "weekly_themes" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "voice_profiles_user_idx" ON "voice_profiles" USING btree ("user_id");