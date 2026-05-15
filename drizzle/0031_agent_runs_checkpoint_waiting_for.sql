-- drizzle/0031_agent_runs_checkpoint_waiting_for.sql
--
-- Phase D (durable lead orchestrator) — Task D1.
-- Additive columns + indexes on agent_runs. No data backfill required:
--   * checkpoint: nullable JSONB, NULL for legacy single-shot teammates
--   * waiting_for: text[] NOT NULL DEFAULT '{}' — existing rows get empty array
--   * next_wake_at: nullable timestamptz, NULL for runs not sleeping on a wake
--
-- Indexes:
--   * GIN partial on waiting_for (only leads actively waiting)
--   * btree partial on next_wake_at (only runs with a scheduled wake)
--
-- No CHECK constraint on `status` yet — D2/D3 introduce the
-- `waiting_for_children` state transition. Keeping D1 minimal.

ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "checkpoint" jsonb;

ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "waiting_for" text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE "agent_runs"
  ADD COLUMN IF NOT EXISTS "next_wake_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_agent_runs_waiting_for"
  ON "agent_runs"
  USING gin ("waiting_for")
  WHERE cardinality("waiting_for") > 0;

CREATE INDEX IF NOT EXISTS "idx_agent_runs_next_wake_at"
  ON "agent_runs" ("next_wake_at")
  WHERE "next_wake_at" IS NOT NULL;
