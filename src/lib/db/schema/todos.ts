import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  real,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { drafts } from './drafts';

export const todoTypeEnum = pgEnum('todo_type', [
  'approve_post',
  'reply_thread',
  'respond_engagement',
]);

export const todoSourceEnum = pgEnum('todo_source', [
  'calendar',
  'discovery',
  'engagement',
]);

export const todoPriorityEnum = pgEnum('todo_priority', [
  'time_sensitive',
  'scheduled',
  'optional',
]);

export const todoStatusEnum = pgEnum('todo_status', [
  'pending',
  'approved',
  'skipped',
  'expired',
]);

export const todoItems = pgTable(
  'todo_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    draftId: text('draft_id').references(() => drafts.id),
    todoType: todoTypeEnum('todo_type').notNull(),
    source: todoSourceEnum('source').notNull(),
    priority: todoPriorityEnum('priority').notNull().default('optional'),
    status: todoStatusEnum('status').notNull().default('pending'),
    title: text('title').notNull(),
    platform: text('platform').notNull(), // 'x' | 'reddit'
    community: text('community'),
    externalUrl: text('external_url'),
    confidence: real('confidence'),
    scheduledFor: timestamp('scheduled_for', { mode: 'date' }),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    actedAt: timestamp('acted_at', { mode: 'date' }),
  },
  (t) => [
    unique('todo_items_user_draft').on(t.userId, t.draftId),
    index('todos_user_status_expires_idx').on(
      t.userId,
      t.status,
      t.expiresAt,
    ),
    // Hot-path index for GET /api/today — supports
    //   WHERE user_id = ? AND status = 'pending' AND expires_at > now()
    // with an index-only path on the three columns actually filtered.
    index('todo_items_user_status_expires').on(
      t.userId,
      t.status,
      t.expiresAt,
    ),
  ],
);
