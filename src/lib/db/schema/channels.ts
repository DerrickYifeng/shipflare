import {
  pgTable,
  text,
  timestamp,
  real,
  integer,
  boolean,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const channels = pgTable('channels', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull().default('reddit'),
  username: text('username').notNull(),
  oauthTokenEncrypted: text('oauth_token_encrypted').notNull(),
  refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
  tokenExpiresAt: timestamp('token_expires_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const threads = pgTable('threads', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  platform: text('platform').notNull().default('reddit'),
  subreddit: text('subreddit').notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  body: text('body'),
  author: text('author'),
  upvotes: integer('upvotes').default(0),
  commentCount: integer('comment_count').default(0),
  relevanceScore: real('relevance_score').notNull(),
  isLocked: boolean('is_locked').default(false),
  isArchived: boolean('is_archived').default(false),
  postedAt: timestamp('posted_at', { mode: 'date' }),
  discoveredAt: timestamp('discovered_at', { mode: 'date' })
    .defaultNow()
    .notNull(),
});
