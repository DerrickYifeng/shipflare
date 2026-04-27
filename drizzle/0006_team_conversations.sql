-- Phase 2 — Claude-style conversation continuity.
--
-- Adds `team_conversations` and wires `team_runs.conversation_id` +
-- `team_messages.conversation_id` so a single persistent conversation
-- spans multiple coordinator runs. See src/lib/team-conversation.ts
-- for the history-reconstruction path.
--
-- Backfill strategy: one conversation PER existing run (not per team).
-- Pre-Phase-2 runs were independent executions with no shared
-- coordinator history; lumping them into one team-wide conversation
-- would make the UI collapse N distinct sessions into a single "Nx"
-- row. All backfilled conversations are 'archived'; the next live
-- user message on a team calls `ensureActiveConversation` to open a
-- fresh 'active' row.
--
-- Teams with no runs get no conversation row — one is created lazily
-- on their next user message.

CREATE TABLE "team_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "title" text,
  "status" text NOT NULL DEFAULT 'active',
  "started_at" timestamp NOT NULL DEFAULT now(),
  "last_turn_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "idx_team_conversations_team_recent"
  ON "team_conversations" ("team_id", "last_turn_at" DESC);

CREATE UNIQUE INDEX "idx_team_conversations_one_active_per_team"
  ON "team_conversations" ("team_id")
  WHERE status = 'active';

ALTER TABLE "team_runs"
  ADD COLUMN "conversation_id" text
  REFERENCES "team_conversations"("id") ON DELETE SET NULL;

ALTER TABLE "team_messages"
  ADD COLUMN "conversation_id" text
  REFERENCES "team_conversations"("id") ON DELETE SET NULL;

CREATE INDEX "idx_team_messages_conversation"
  ON "team_messages" ("conversation_id", "created_at");

-- Backfill step 1: one conversation per existing run.
-- Temporary id_seed carries the run id forward so we can stitch runs,
-- messages, and conversations together deterministically in step 2+3.
WITH new_convs AS (
  INSERT INTO "team_conversations" (id, team_id, title, status, started_at, last_turn_at)
  SELECT
    gen_random_uuid()::text,
    r.team_id,
    NULL,
    'archived',
    r.started_at,
    COALESCE(r.completed_at, r.started_at)
  FROM "team_runs" r
  WHERE r.conversation_id IS NULL
  RETURNING id, team_id, started_at
)
-- Step 2: repoint each run to its per-run conversation.
-- Match on (team_id, started_at) — safe because team_runs has no
-- duplicates on that pair in practice, and the conversation we just
-- inserted has identical values.
UPDATE "team_runs" r
SET conversation_id = c.id
FROM new_convs c
WHERE r.conversation_id IS NULL
  AND c.team_id = r.team_id
  AND c.started_at = r.started_at;

-- Step 3: route each message to its run's (now-assigned) conversation.
UPDATE "team_messages" m
SET conversation_id = r.conversation_id
FROM "team_runs" r
WHERE m.run_id = r.id
  AND m.conversation_id IS NULL;
