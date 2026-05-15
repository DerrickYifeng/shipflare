CREATE TABLE "product_reddit_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"user_id" text NOT NULL,
	"subreddit" text NOT NULL,
	"member_count" integer,
	"fit_score" real,
	"rules_summary" text,
	"activity" jsonb,
	"rank" integer DEFAULT 99 NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_reddit_channels" ADD CONSTRAINT "product_reddit_channels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reddit_channels" ADD CONSTRAINT "product_reddit_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_reddit_channels_product_subreddit_uq" ON "product_reddit_channels" USING btree ("product_id","subreddit");--> statement-breakpoint
CREATE INDEX "product_reddit_channels_product_active_idx" ON "product_reddit_channels" USING btree ("product_id","disabled","rank");