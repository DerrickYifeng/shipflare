-- Phase G cleanup: drop the dead team_runs table.
--
-- Phase E unified the lead/teammate runs under agent_runs and stopped
-- writing team_runs rows. The table + its FKs lingered, causing the
-- Task tool to crash with "insert or update on team_tasks violates
-- foreign key constraint team_tasks_run_id_team_runs_id_fk" whenever a
-- new task spawn tried to point at a team_runs row that was never
-- created.
--
-- Order matters here. Drop the FK constraints FIRST so the
-- subsequent DROP TABLE doesn't have to rely on CASCADE to clean
-- them up — the auto-generated drizzle-kit output reversed this and
-- emitted the constraint-drop AFTER the table-drop, which fails
-- (`constraint does not exist` because CASCADE already removed it).
--
-- IF EXISTS guards keep the migration idempotent on dev DBs whose
-- constraint names may differ from drizzle's default convention.
ALTER TABLE "team_messages" DROP CONSTRAINT IF EXISTS "team_messages_run_id_team_runs_id_fk";--> statement-breakpoint
ALTER TABLE "team_tasks" DROP CONSTRAINT IF EXISTS "team_tasks_run_id_team_runs_id_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "team_runs" CASCADE;
