-- Account delete was failing with 500 when a user with active team runs
-- tried to delete themselves: cascading users -> teams -> team_members
-- fired in parallel with users -> teams -> team_runs -> team_tasks, and
-- team_tasks.member_id -> team_members.id was RESTRICT by default.
--
-- This migration replaces the four team_members.id references so the
-- cascade drains cleanly:
--   - team_tasks.member_id       (NOT NULL) -> CASCADE
--   - team_runs.root_agent_id    (NOT NULL) -> CASCADE
--   - team_messages.from_member_id (nullable) -> SET NULL (preserve history)
--   - team_messages.to_member_id   (nullable) -> SET NULL (preserve history)

ALTER TABLE "team_tasks"
  DROP CONSTRAINT "team_tasks_member_id_team_members_id_fk";
--> statement-breakpoint
ALTER TABLE "team_tasks"
  ADD CONSTRAINT "team_tasks_member_id_team_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "team_runs"
  DROP CONSTRAINT "team_runs_root_agent_id_team_members_id_fk";
--> statement-breakpoint
ALTER TABLE "team_runs"
  ADD CONSTRAINT "team_runs_root_agent_id_team_members_id_fk"
  FOREIGN KEY ("root_agent_id") REFERENCES "public"."team_members"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "team_messages"
  DROP CONSTRAINT "team_messages_from_member_id_team_members_id_fk";
--> statement-breakpoint
ALTER TABLE "team_messages"
  ADD CONSTRAINT "team_messages_from_member_id_team_members_id_fk"
  FOREIGN KEY ("from_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "team_messages"
  DROP CONSTRAINT "team_messages_to_member_id_team_members_id_fk";
--> statement-breakpoint
ALTER TABLE "team_messages"
  ADD CONSTRAINT "team_messages_to_member_id_team_members_id_fk"
  FOREIGN KEY ("to_member_id") REFERENCES "public"."team_members"("id")
  ON DELETE set null ON UPDATE no action;
