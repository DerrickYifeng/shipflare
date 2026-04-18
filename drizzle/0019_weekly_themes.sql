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
ALTER TABLE "x_content_calendar" ADD COLUMN "angle" text;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD COLUMN "theme_id" text;--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD COLUMN "is_white_space" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_themes" ADD CONSTRAINT "weekly_themes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_themes" ADD CONSTRAINT "weekly_themes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_themes_user_channel_idx" ON "weekly_themes" USING btree ("user_id","channel");--> statement-breakpoint
ALTER TABLE "x_content_calendar" ADD CONSTRAINT "x_content_calendar_theme_id_weekly_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."weekly_themes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "xcc_theme_idx" ON "x_content_calendar" USING btree ("theme_id");