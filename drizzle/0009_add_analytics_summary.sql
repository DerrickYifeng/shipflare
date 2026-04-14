CREATE TABLE IF NOT EXISTS "x_analytics_summary" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_start" timestamp NOT NULL,
  "period_end" timestamp NOT NULL,
  "best_content_types" jsonb NOT NULL,
  "best_posting_hours" jsonb NOT NULL,
  "audience_growth_rate" real NOT NULL DEFAULT 0,
  "engagement_rate" real NOT NULL DEFAULT 0,
  "total_impressions" integer NOT NULL DEFAULT 0,
  "total_bookmarks" integer NOT NULL DEFAULT 0,
  "computed_at" timestamp DEFAULT now() NOT NULL
);
