-- drizzle/0030_growth_rollup_tables.sql
DROP TABLE IF EXISTS "health_scores";

CREATE TABLE IF NOT EXISTS "channel_scores" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "score" integer NOT NULL,
  "threads" integer NOT NULL,
  "drafts" integer NOT NULL,
  "posts" integer NOT NULL,
  "replies" integer NOT NULL,
  "pending" integer NOT NULL,
  "approve_rate" real,
  "last_post_at" timestamp,
  "calculated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "channel_scores_user_platform_idx"
  ON "channel_scores" ("user_id", "platform", "calculated_at" DESC);

CREATE TABLE IF NOT EXISTS "module_scores" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "module_id" text NOT NULL,
  "score" integer NOT NULL,
  "calculated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "module_scores_user_module_idx"
  ON "module_scores" ("user_id", "module_id", "calculated_at" DESC);
