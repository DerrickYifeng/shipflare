import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { desc } from 'drizzle-orm';
import { users } from './users';
import { products } from './products';
import { threads } from './channels';
import { drafts, posts } from './drafts';

/**
 * Pipeline events: one row per stage transition in the funnel.
 *
 * Stages (not enforced as a pg enum to keep additions cheap):
 *   discovered | gate_passed | draft_created | reviewed | approved |
 *   posted    | engaged     | failed
 *
 * Written from workers and approve routes via `recordPipelineEvent()` in
 * `src/lib/pipeline-events.ts`. Reads are powered by the dashboard funnel
 * view. Failures inserting here MUST NOT bubble up to the caller —
 * telemetry must never break the main pipeline.
 */
export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, {
      onDelete: 'set null',
    }),
    stage: text('stage').notNull(),
    threadId: text('thread_id').references(() => threads.id, {
      onDelete: 'set null',
    }),
    draftId: text('draft_id').references(() => drafts.id, {
      onDelete: 'set null',
    }),
    postId: text('post_id').references(() => posts.id, {
      onDelete: 'set null',
    }),
    enteredAt: timestamp('entered_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
    durationMs: integer('duration_ms'),
    cost: doublePrecision('cost'),
    metadata: jsonb('metadata'),
  },
  (t) => [
    index('pipeline_events_user_stage_entered').on(
      t.userId,
      t.stage,
      desc(t.enteredAt),
    ),
    index('pipeline_events_user_entered').on(t.userId, desc(t.enteredAt)),
    index('pipeline_events_thread_entered_idx').on(t.threadId, desc(t.enteredAt)),
    index('pipeline_events_draft_entered_idx').on(t.draftId, desc(t.enteredAt)),
  ],
);

export type PipelineEvent = typeof pipelineEvents.$inferSelect;
export type NewPipelineEvent = typeof pipelineEvents.$inferInsert;

/**
 * Thread feedback: a lightweight ground-truth table for the Discovery
 * optimization loop. Records the user's disposition on a discovered thread
 * (skip / approve / post) so we can later re-calibrate the scorer.
 *
 * Uniqueness is per (userId, threadId) — a user can only have one canonical
 * disposition per thread. The post-action upserts over the approve row.
 */
export const threadFeedback = pgTable(
  'thread_feedback',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    userAction: text('user_action').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('thread_feedback_user_thread_uq').on(t.userId, t.threadId),
  ],
);

export type ThreadFeedback = typeof threadFeedback.$inferSelect;
export type NewThreadFeedback = typeof threadFeedback.$inferInsert;
