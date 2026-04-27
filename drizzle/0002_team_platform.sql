-- Phase A Day 4 of the AI Team Platform refactor (see
-- docs/superpowers/specs/2026-04-20-ai-team-platform-design.md §6.1).
--
-- Five new tables back the team runtime:
--   - teams           : user's AI team
--   - team_members    : AGENT.md instances per team
--   - team_runs       : one coordinator main-loop execution
--   - team_messages   : every assistant / tool_use / tool_result / user prompt
--   - team_tasks      : Task-tool spawn record (1 row per Task call)
--
-- Column types match the rest of the schema: text IDs with application-side
-- UUIDs (see users.id / products.id / plan_items.id) rather than pg `uuid`.
-- The Drizzle schema file (src/lib/db/schema/team.ts) is the TS mirror.
--
-- Partial unique index `idx_team_runs_one_running_per_team` enforces
-- spec §16's "Race condition: two team_runs for same team" mitigation —
-- only one team_run per team can sit in status='running' at a time.

CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text,
	"name" text DEFAULT 'My Marketing Team' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"agent_type" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_active_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_agent_type_unique" UNIQUE("team_id","agent_type")
);
--> statement-breakpoint
CREATE TABLE "team_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"trigger" text NOT NULL,
	"goal" text NOT NULL,
	"root_agent_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"total_cost_usd" numeric(10,4),
	"total_turns" integer DEFAULT 0,
	"trace_id" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "team_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"team_id" text NOT NULL,
	"from_member_id" text,
	"to_member_id" text,
	"type" text NOT NULL,
	"content" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"parent_task_id" text,
	"member_id" text NOT NULL,
	"description" text NOT NULL,
	"prompt" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"cost_usd" numeric(10,4),
	"turns" integer DEFAULT 0,
	"started_at" timestamp,
	"completed_at" timestamp,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_runs" ADD CONSTRAINT "team_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_runs" ADD CONSTRAINT "team_runs_root_agent_id_team_members_id_fk" FOREIGN KEY ("root_agent_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_run_id_team_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."team_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_from_member_id_team_members_id_fk" FOREIGN KEY ("from_member_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_to_member_id_team_members_id_fk" FOREIGN KEY ("to_member_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_run_id_team_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."team_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_parent_task_id_team_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."team_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_member_id_team_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_teams_user_product" ON "teams" USING btree ("user_id","product_id");
--> statement-breakpoint
CREATE INDEX "idx_team_members_team" ON "team_members" USING btree ("team_id");
--> statement-breakpoint
CREATE INDEX "idx_team_runs_team_status" ON "team_runs" USING btree ("team_id","status");
--> statement-breakpoint
CREATE INDEX "idx_team_runs_trace" ON "team_runs" USING btree ("trace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_team_runs_one_running_per_team" ON "team_runs" USING btree ("team_id") WHERE status = 'running';
--> statement-breakpoint
CREATE INDEX "idx_team_messages_run" ON "team_messages" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_team_messages_team_recent" ON "team_messages" USING btree ("team_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_team_tasks_run" ON "team_tasks" USING btree ("run_id","started_at");
--> statement-breakpoint
CREATE INDEX "idx_team_tasks_member" ON "team_tasks" USING btree ("member_id");
