// AI Team Platform tables (Phase A Day 4). See spec §6.1 in
// docs/superpowers/specs/2026-04-20-ai-team-platform-design.md.
//
// Five tables model a user's AI team runtime:
//   teams          — one row per product-scoped team
//   team_members   — instances of AgentDefinition (AGENT.md) attached to a team
//   team_messages  — every message that flowed during a run (user ↔ member ↔ tool)
//   team_tasks     — one row per Task-tool spawn (supports nested spawns via parent_task_id)
//   agent_runs     — one row per agent invocation (Phase B+ unified runtime;
//                    superseded the deleted team_runs table — see migration
//                    0016_drop_team_runs)
//
// ID convention mirrors the existing schema (users.id, products.id): text
// columns populated with application-side UUIDs via `$defaultFn(() => crypto.randomUUID())`.

import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { products } from './products';

// ---------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------

export const teams = pgTable(
  'teams',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull().default('My Marketing Team'),
    // { preset?: 'default' | 'dev_tool' | 'consumer' | ..., weeklyBudgetUsd?: number }
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [index('idx_teams_user_product').on(t.userId, t.productId)],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

// ---------------------------------------------------------------------------
// team_conversations  (Chat refactor — ChatGPT-style first-class threads)
// ---------------------------------------------------------------------------
//
// A conversation is a persistent thread between the user and the team's
// coordinator. This is the PRIMARY UI unit — what the user sees in the
// sidebar, clicks to focus, and sends messages into. Runs are internal
// bookkeeping (one coordinator execution per user message), scoped to a
// conversation.
//
// No `status` / `last_turn_at` / partial-active-unique-index: the
// earlier Phase 2 model tried to infer "which conversation is the user
// in right now" server-side; that was the root of every race we hit.
// Now the CLIENT tracks focus and passes `conversationId` explicitly
// on every send — the server never guesses.
//
// `updatedAt` advances on every new user message, so the sidebar can
// sort "most recently active conversation first" without tracking a
// separate `lastTurnAt`.

export const teamConversations = pgTable(
  'team_conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Human-readable title — defaults to null and backfilled from the
     *  first user message's first ~60 chars once we have one. */
    title: text('title'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    /** Bumped on every new message; drives sidebar sort order. */
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_team_conversations_team_recent').on(
      t.teamId,
      t.updatedAt.desc(),
    ),
  ],
);

export type TeamConversation = typeof teamConversations.$inferSelect;
export type NewTeamConversation = typeof teamConversations.$inferInsert;

// ---------------------------------------------------------------------------
// team_members
// ---------------------------------------------------------------------------

export const teamMembers = pgTable(
  'team_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    // Must match an AGENT.md `name` under src/tools/AgentTool/agents/<agent_type>.
    agentType: text('agent_type').notNull(),
    // Product-decided presentation name ("Alex" for content-planner).
    displayName: text('display_name').notNull(),
    // 'idle' | 'active' | 'waiting_approval' | 'error'
    status: text('status').notNull().default('idle'),
    lastActiveAt: timestamp('last_active_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_team_members_team').on(t.teamId),
    unique('team_members_team_agent_type_unique').on(t.teamId, t.agentType),
  ],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;

// ---------------------------------------------------------------------------
// team_messages
// ---------------------------------------------------------------------------

export const teamMessages = pgTable(
  'team_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Phase G cleanup (migration 0016_drop_team_runs): the FK to team_runs
    // is gone. runId is now a free-text grouping handle pointing at the
    // user_prompt team_messages.id that initiated this row's request.
    // Nullable because system messages (cron broadcasts, etc.) may not be
    // tied to a request.
    runId: text('run_id'),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Phase 2: conversation this message belongs to. Nullable during
     *  the migration window — legacy rows written before Phase 2 have
     *  no conversation; see migration 0006 for the one-shot backfill. */
    conversationId: text('conversation_id').references(
      () => teamConversations.id,
      { onDelete: 'set null' },
    ),
    // NULL = user
    fromMemberId: text('from_member_id').references(() => teamMembers.id, {
      onDelete: 'set null',
    }),
    // NULL = user, or broadcast
    toMemberId: text('to_member_id').references(() => teamMembers.id, {
      onDelete: 'set null',
    }),
    // 'user_prompt' | 'agent_text' | 'tool_call' | 'tool_result' | 'completion' | 'error' | 'thinking'
    type: text('type').notNull(),
    content: text('content'),
    // { tool_use_id?, tool_name?, tool_input?, tool_output?, cost?, tokens?, ... }
    metadata: jsonb('metadata'),
    // ----------------- Phase B (Agent Teams) routing columns -----------------
    /**
     * Agent Teams protocol type. Orthogonal to existing `type` (which is
     * the LLM-flow kind: user_prompt / agent_text / tool_call / etc.).
     * `task_notification` rows have type='user_prompt' AND
     * messageType='task_notification'.
     */
    messageType: text('message_type').notNull().default('message'),
    /** Specific run reference for Agent Teams routing (additive to the
     *  existing fromMemberId/toMemberId which point at the static
     *  team roster). Required because the same member can have multiple
     *  historical agent_runs. */
    fromAgentId: text('from_agent_id'),
    toAgentId: text('to_agent_id'),
    /** Mailbox drain idempotency marker. NULL = not yet delivered. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** 1-line preview shown to team-lead via peer-DM visibility (Phase C). */
    summary: text('summary'),
    /** Reply-to chain (Phase C shutdown_response / plan_approval_response). */
    repliesToId: text('replies_to_id'),
    /**
     * Phase 2b — Anthropic-native content blocks for this row.
     *
     * When populated, this is the exact `ContentBlockParam[]` the
     * Claude API expects for this turn's content. The loader concats
     * these across rows by role, without re-deriving blocks from
     * `content` / `metadata`. Nullable for legacy rows (pre-migration)
     * and for types the write path doesn't yet standardize (`thinking`,
     * `error`). See `src/lib/team-conversation.ts`. Inspired by Claude
     * Code's session JSONL: each record carries self-describing,
     * ready-to-replay content.
     */
    contentBlocks: jsonb('content_blocks'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_team_messages_run').on(t.runId, t.createdAt),
    index('idx_team_messages_team_recent').on(t.teamId, t.createdAt.desc()),
    /** Phase 2: primary read path — loadConversationHistory scans by
     *  conversation_id in chronological order. */
    index('idx_team_messages_conversation').on(
      t.conversationId,
      t.createdAt,
    ),
    /** Phase B (Agent Teams): mailbox drain — per-recipient pending
     *  message lookup. Partial index keeps the index small as messages
     *  age out (delivered rows are excluded). */
    index('idx_team_messages_to_undelivered')
      .on(t.toAgentId, t.deliveredAt)
      .where(sql`delivered_at IS NULL`),
  ],
);

export type TeamMessage = typeof teamMessages.$inferSelect;
export type NewTeamMessage = typeof teamMessages.$inferInsert;

// ---------------------------------------------------------------------------
// team_tasks
// ---------------------------------------------------------------------------

export const teamTasks = pgTable(
  'team_tasks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Phase G cleanup (migration 0016_drop_team_runs): the FK to team_runs
    // is gone. runId is now a free-text grouping handle pointing at the
    // user_prompt team_messages.id that initiated the request. Stays
    // notNull because every Task spawn happens inside a request — never
    // standalone.
    runId: text('run_id').notNull(),
    // Nested spawns (A spawns B spawns C) chain through here.
    parentTaskId: text('parent_task_id'),
    memberId: text('member_id')
      .notNull()
      .references(() => teamMembers.id, { onDelete: 'cascade' }),
    // Task tool's `description` param (3-5 words).
    description: text('description').notNull(),
    // Task tool's `prompt` param.
    prompt: text('prompt').notNull(),
    // Full Task input (subagent_type, name, ...).
    input: jsonb('input').notNull(),
    // StructuredOutput result or final text.
    output: jsonb('output'),
    // 'pending' | 'running' | 'completed' | 'failed'
    status: text('status').notNull().default('pending'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    turns: integer('turns').default(0),
    startedAt: timestamp('started_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('idx_team_tasks_run').on(t.runId, t.startedAt),
    index('idx_team_tasks_member').on(t.memberId),
  ],
);

export type TeamTask = typeof teamTasks.$inferSelect;
export type NewTeamTask = typeof teamTasks.$inferInsert;

// ---------------------------------------------------------------------------
// agent_runs — one row per agent invocation in the unified Agent Teams
// runtime (Phase B+). Covers both team-lead and teammate runs (Phase E
// unifies the entry path; Phase B only constructs teammate rows via
// the Task tool's async branch).
//
// Status state machine (Phase B subset — Sleep/resume land in Phase D):
//   queued → running → (completed | failed | killed)
//
// `parent_agent_id` is NULL for lead runs; set to the parent's agent_id
// for teammate runs spawned by Task({run_in_background:true}).
//
// NOTE: `parent_agent_id` is a self-reference to `agent_runs.id`. Drizzle
// supports self-references in pgTable definitions via the column thunk
// pattern, but to avoid a circular-init edge case we declare the column
// without an explicit `.references()` and rely on the FK being added at
// the SQL migration layer in a follow-up. Phase B has no consumer that
// needs Drizzle's relational query builder to traverse this FK; cascades
// from `team_id` / `member_id` already cover the common cleanup case.
// TODO: enforce parentAgentId → agent_runs.id FK in a follow-up
// migration once the self-ref pattern is sorted out.
// ---------------------------------------------------------------------------

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => teamMembers.id, { onDelete: 'cascade' }),
    agentDefName: text('agent_def_name').notNull(),
    parentAgentId: text('parent_agent_id'),
    bullmqJobId: text('bullmq_job_id'),
    status: text('status').notNull().default('queued'),
    transcriptId: text('transcript_id'),
    spawnedAt: timestamp('spawned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sleepUntil: timestamp('sleep_until', { withTimezone: true }),
    shutdownReason: text('shutdown_reason'),
    totalTokens: bigint('total_tokens', { mode: 'number' }).default(0),
    toolUses: integer('tool_uses').default(0),
  },
  (t) => [
    index('idx_agent_runs_team_status_active').on(
      t.teamId,
      t.status,
      t.lastActiveAt,
    ),
    index('idx_agent_runs_sleep_until').on(t.sleepUntil),
    index('idx_agent_runs_parent').on(t.parentAgentId),
  ],
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
