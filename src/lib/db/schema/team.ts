// AI Team Platform tables (Phase A Day 4). See spec §6.1 in
// docs/superpowers/specs/2026-04-20-ai-team-platform-design.md.
//
// Five tables model a user's AI team runtime:
//   teams          — one row per product-scoped team
//   team_members   — instances of AgentDefinition (AGENT.md) attached to a team
//   team_runs      — a single coordinator main-loop execution
//   team_messages  — every message that flowed during a run (user ↔ member ↔ tool)
//   team_tasks     — one row per Task-tool spawn (supports nested spawns via parent_task_id)
//
// ID convention mirrors the existing schema (users.id, products.id): text
// columns populated with application-side UUIDs via `$defaultFn(() => crypto.randomUUID())`.

import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
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
// team_runs
// ---------------------------------------------------------------------------

export const teamRuns = pgTable(
  'team_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** Phase 2: the conversation this run belongs to. Nullable for
     *  legacy rows that predate the team_conversations table. */
    conversationId: text('conversation_id').references(
      () => teamConversations.id,
      { onDelete: 'set null' },
    ),
    // 'onboarding' | 'kickoff' | 'weekly' | 'daily' | 'phase_transition' | 'draft_post'
    trigger: text('trigger').notNull(),
    goal: text('goal').notNull(),
    rootAgentId: text('root_agent_id')
      .notNull()
      .references(() => teamMembers.id, { onDelete: 'cascade' }),
    // 'running' | 'completed' | 'failed' | 'cancelled' | 'pending'
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    totalCostUsd: numeric('total_cost_usd', { precision: 10, scale: 4 }),
    totalTurns: integer('total_turns').default(0),
    traceId: text('trace_id'),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('idx_team_runs_team_status').on(t.teamId, t.status),
    index('idx_team_runs_trace').on(t.traceId),
    // Partial unique index — spec §16: only one 'running' team_run per team.
    // Drizzle-kit emits this via the `.where(...)` helper on uniqueIndex.
    uniqueIndex('idx_team_runs_one_running_per_team')
      .on(t.teamId)
      .where(sql`status = 'running'`),
  ],
);

export type TeamRun = typeof teamRuns.$inferSelect;
export type NewTeamRun = typeof teamRuns.$inferInsert;

// ---------------------------------------------------------------------------
// team_messages
// ---------------------------------------------------------------------------

export const teamMessages = pgTable(
  'team_messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id').references(() => teamRuns.id, { onDelete: 'cascade' }),
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
    runId: text('run_id')
      .notNull()
      .references(() => teamRuns.id, { onDelete: 'cascade' }),
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
