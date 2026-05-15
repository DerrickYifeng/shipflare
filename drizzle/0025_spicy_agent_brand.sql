-- Add `parent_tool_use_id` to `agent_runs`. Required for async teammate
-- spawns (Task(run_in_background:true)) so the agent-run worker can wrap
-- the teammate's onEvent with a `spawnMeta.parentToolUseId` matching the
-- lead's Task tool_use_id. Without this, teammate-emitted tool_call /
-- agent_text rows land in `team_messages` with no parent_tool_use_id,
-- the founder UI's conversation-reducer can't bucket them under the
-- DelegationCard's task.toolUseId, and the dispatch card renders
-- "thinking…" forever even while the worker is producing tool_use
-- blocks (logs prove activity, UI shows nothing).
--
-- Nullable: legacy agent_runs predate this column; backfill is unnecessary
-- because those rows are terminal. New spawns from spawnSubagent stamp it
-- from `ctx.get('toolUseId')`.

ALTER TABLE "agent_runs" ADD COLUMN "parent_tool_use_id" text;
