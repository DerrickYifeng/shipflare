-- drizzle-orm: always-run
-- Wave 2.2 · agent_memories: add user_id column, backfill from products, conditional NOT NULL
--> statement-breakpoint

-- Step 1: ADD COLUMN user_id (nullable) if not already present
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_memories' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE "agent_memories" ADD COLUMN "user_id" text;
  END IF;
END $$;
--> statement-breakpoint

-- Step 2: Backfill user_id from products via product_id JOIN
UPDATE "agent_memories" am
SET "user_id" = p."user_id"
FROM "products" p
WHERE am."product_id" = p."id"
  AND am."user_id" IS NULL;
--> statement-breakpoint

-- Step 3: Orphan check — if all rows backfilled, promote to NOT NULL; else NOTICE and leave nullable
DO $$ DECLARE orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "agent_memories"
  WHERE "user_id" IS NULL;

  IF orphan_count = 0 THEN
    IF (
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'agent_memories' AND column_name = 'user_id'
    ) = 'YES' THEN
      ALTER TABLE "agent_memories" ALTER COLUMN "user_id" SET NOT NULL;
    END IF;
  ELSE
    RAISE NOTICE 'agent_memories has % rows with NULL user_id (orphan product_id refs). Diagnostic: SELECT id, product_id FROM agent_memories WHERE user_id IS NULL. SET NOT NULL deferred — clean up orphans and re-run this migration (hash unchanged, nothing replays) or apply a follow-up migration.', orphan_count;
  END IF;
END $$;
--> statement-breakpoint

-- Step 4: ADD FK agent_memories_user_id_users_id_fk → users(id) ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_memories_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "agent_memories"
      ADD CONSTRAINT "agent_memories_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint

-- Step 5: CREATE INDEX on user_id
CREATE INDEX IF NOT EXISTS "agent_memories_user_idx" ON "agent_memories" ("user_id");
