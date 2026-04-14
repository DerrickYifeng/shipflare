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
	"scanned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "code_snapshots_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "x_content_calendar" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"content_type" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"topic" text,
	"draft_id" text,
	"posted_tweet_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_follower_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"follower_count" integer NOT NULL,
	"following_count" integer NOT NULL,
	"tweet_count" integer NOT NULL,
	"snapshot_at" timestamp DEFAULT now() NOT NULL
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
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "x_monitored_tweets_user_tweet" UNIQUE("user_id","tweet_id")
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
ALTER TABLE "products" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "code_snapshots" ADD CONSTRAINT "code_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_snapshots" ADD CONSTRAINT "code_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_follower_snapshots" ADD CONSTRAINT "x_follower_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_monitored_tweets" ADD CONSTRAINT "x_monitored_tweets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_monitored_tweets" ADD CONSTRAINT "x_monitored_tweets_target_account_id_x_target_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."x_target_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_target_accounts" ADD CONSTRAINT "x_target_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_tweet_metrics" ADD CONSTRAINT "x_tweet_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "x_tweet_metrics_user_tweet" ON "x_tweet_metrics" USING btree ("user_id","tweet_id");