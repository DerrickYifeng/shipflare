import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  real,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { threads } from './channels';

export const draftStatusEnum = pgEnum('draft_status', [
  'pending',
  'approved',
  'skipped',
  'posted',
  'failed',
]);

export const postStatusEnum = pgEnum('post_status', [
  'posted',
  'removed',
  'verified',
]);

export const drafts = pgTable('drafts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  status: draftStatusEnum('status').notNull().default('pending'),
  replyBody: text('reply_body').notNull(),
  confidenceScore: real('confidence_score').notNull(),
  whyItWorks: text('why_it_works'),
  ftcDisclosure: text('ftc_disclosure'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const posts = pgTable('posts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  draftId: text('draft_id')
    .notNull()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: postStatusEnum('status').notNull().default('posted'),
  externalId: text('external_id'),
  externalUrl: text('external_url'),
  subreddit: text('subreddit').notNull(),
  postedAt: timestamp('posted_at', { mode: 'date' }).defaultNow().notNull(),
});

export const healthScores = pgTable('health_scores', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  score: integer('score').notNull(),
  s1Pipeline: real('s1_pipeline').notNull(),
  s2Quality: real('s2_quality').notNull(),
  s3Engagement: real('s3_engagement').notNull(),
  s4Consistency: real('s4_consistency').notNull(),
  s5Safety: real('s5_safety').notNull(),
  calculatedAt: timestamp('calculated_at', { mode: 'date' })
    .defaultNow()
    .notNull(),
});

export const activityEvents = pgTable('activity_events', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  metadataJson: jsonb('metadata_json'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});
