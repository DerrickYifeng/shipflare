import {
  pgTable,
  text,
  timestamp,
  real,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { desc } from 'drizzle-orm';
import { users } from './users';

export const channelScores = pgTable(
  'channel_scores',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    score: integer('score').notNull(),
    threads: integer('threads').notNull(),
    drafts: integer('drafts').notNull(),
    posts: integer('posts').notNull(),
    replies: integer('replies').notNull(),
    pending: integer('pending').notNull(),
    approveRate: real('approve_rate'),
    lastPostAt: timestamp('last_post_at', { mode: 'date' }),
    calculatedAt: timestamp('calculated_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('channel_scores_user_platform_idx').on(
      t.userId,
      t.platform,
      desc(t.calculatedAt),
    ),
  ],
);

export const moduleScores = pgTable(
  'module_scores',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    score: integer('score').notNull(),
    calculatedAt: timestamp('calculated_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('module_scores_user_module_idx').on(
      t.userId,
      t.moduleId,
      desc(t.calculatedAt),
    ),
  ],
);
