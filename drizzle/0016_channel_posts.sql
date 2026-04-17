-- drizzle-orm: always-run
--
-- Wave 2.3 — create channel_posts table, backfill from channels.post_history JSONB.
-- Normalizes the per-channel post seed out of a JSONB array into a queryable table.
-- All statements idempotent (IF NOT EXISTS, ON CONFLICT).
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "channel_posts" (
  "id"          text PRIMARY KEY,
  "channel_id"  text NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "text"        text NOT NULL,
  "type"        text NOT NULL,
  "posted_at"   timestamptz NOT NULL,
  CONSTRAINT "channel_posts_type_chk" CHECK (type IN ('post', 'reply'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "channel_posts_channel_external_uq"
  ON "channel_posts" ("channel_id", "external_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "channel_posts_channel_posted_idx"
  ON "channel_posts" ("channel_id", "posted_at" DESC);
--> statement-breakpoint

-- Backfill from channels.post_history JSONB
INSERT INTO "channel_posts" ("id", "channel_id", "external_id", "text", "type", "posted_at")
SELECT
  gen_random_uuid()::text,
  c."id",
  elem->>'id',
  elem->>'text',
  elem->>'type',
  (elem->>'createdAt')::timestamptz
FROM "channels" c,
  jsonb_array_elements(c."post_history") AS elem
WHERE c."post_history" IS NOT NULL
  AND jsonb_array_length(c."post_history") > 0
  AND (elem->>'id') IS NOT NULL
  AND (elem->>'text') IS NOT NULL AND (elem->>'text') != ''
  AND (elem->>'type') IN ('post', 'reply')
  AND (elem->>'createdAt') IS NOT NULL
ON CONFLICT ("channel_id", "external_id") DO NOTHING;
