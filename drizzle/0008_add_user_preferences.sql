CREATE TABLE IF NOT EXISTS "user_preferences" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "auto_approve_enabled" boolean NOT NULL DEFAULT false,
  "auto_approve_threshold" real NOT NULL DEFAULT 0.85,
  "auto_approve_types" jsonb NOT NULL DEFAULT '["reply"]'::jsonb,
  "max_auto_approvals_per_day" integer NOT NULL DEFAULT 10,
  "posting_hours_utc" jsonb NOT NULL DEFAULT '[14, 17, 21]'::jsonb,
  "content_mix_metric" integer NOT NULL DEFAULT 40,
  "content_mix_educational" integer NOT NULL DEFAULT 30,
  "content_mix_engagement" integer NOT NULL DEFAULT 20,
  "content_mix_product" integer NOT NULL DEFAULT 10,
  "notify_on_new_draft" boolean NOT NULL DEFAULT true,
  "notify_on_auto_approve" boolean NOT NULL DEFAULT true,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_preferences_user_id" UNIQUE("user_id")
);
