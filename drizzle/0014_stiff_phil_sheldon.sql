CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"member_id" text NOT NULL,
	"agent_def_name" text NOT NULL,
	"parent_agent_id" text,
	"bullmq_job_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"transcript_id" text,
	"spawned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sleep_until" timestamp with time zone,
	"shutdown_reason" text,
	"total_tokens" bigint DEFAULT 0,
	"tool_uses" integer DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE "team_messages" ADD COLUMN "message_type" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_messages" ADD COLUMN "from_agent_id" text;--> statement-breakpoint
ALTER TABLE "team_messages" ADD COLUMN "to_agent_id" text;--> statement-breakpoint
ALTER TABLE "team_messages" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_messages" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "team_messages" ADD COLUMN "replies_to_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_member_id_team_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."team_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_runs_team_status_active" ON "agent_runs" USING btree ("team_id","status","last_active_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_sleep_until" ON "agent_runs" USING btree ("sleep_until");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_parent" ON "agent_runs" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE INDEX "idx_team_messages_to_undelivered" ON "team_messages" USING btree ("to_agent_id","delivered_at") WHERE delivered_at IS NULL;
