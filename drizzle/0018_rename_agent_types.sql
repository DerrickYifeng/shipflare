-- Plan 3: collapse content-manager + content-planner + discovery-agent
-- into one social-media-manager agent.
--
-- Order matters:
--  1. Rename content-manager rows in place (preserves member id, conversation
--     history, and any FK references from agent_runs / team_messages).
--  2. Delete content-planner rows (their work is absorbed by the coordinator).
--  3. Delete discovery-agent rows (their work is absorbed by the social-media-manager
--     via find_threads_via_xai).
--
-- All three are idempotent — WHERE clauses filter by old name only.
--
-- FK cascade behavior (verified pre-migration):
--   - agent_runs.member_id      → ON DELETE CASCADE   (deletes runs for removed members)
--   - team_tasks.member_id      → ON DELETE CASCADE   (deletes tasks for removed members)
--   - team_messages.from_member_id → ON DELETE SET NULL (preserves message history)
--   - team_messages.to_member_id   → ON DELETE SET NULL (preserves message history)
--
-- Note: team_members has no `updated_at` column — only `created_at` and `last_active_at`.

UPDATE "team_members"
SET agent_type = 'social-media-manager',
    display_name = 'Social Media Manager'
WHERE agent_type = 'content-manager';
--> statement-breakpoint

DELETE FROM "team_members" WHERE agent_type = 'content-planner';
--> statement-breakpoint

DELETE FROM "team_members" WHERE agent_type = 'discovery-agent';
