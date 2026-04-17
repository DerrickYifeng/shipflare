import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  real,
  integer,
  boolean,
  jsonb,
  unique,
  index,
  uniqueIndex,
  date,
} from 'drizzle-orm/pg-core';
import { desc } from 'drizzle-orm';
import { users } from './users';
import { products } from './products';
import { drafts } from './drafts';

/**
 * Target accounts to monitor for the Reply Guy Engine.
 * Tracks big accounts whose tweets we want to reply to quickly.
 */
export const xTargetAccounts = pgTable(
  'x_target_accounts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    displayName: text('display_name'),
    xUserId: text('x_user_id'),
    followerCount: integer('follower_count'),
    priority: integer('priority').notNull().default(1),
    category: text('category'), // 'competitor' | 'influencer' | 'peer' | 'media'
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [unique('x_target_accounts_user_username').on(table.userId, table.username)],
);

export const xMonitoredTweetStatusEnum = pgEnum('x_monitored_tweet_status', [
  'pending', 'draft_created', 'replied', 'skipped', 'expired',
]);

export const xContentCalendarStatusEnum = pgEnum('x_content_calendar_status', [
  'scheduled', 'draft_created', 'approved', 'posted', 'skipped',
]);

/**
 * Tweets from monitored target accounts.
 * Each tweet has a 15-minute reply window for maximum algorithm impact.
 */
export const xMonitoredTweets = pgTable(
  'x_monitored_tweets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetAccountId: text('target_account_id')
      .notNull()
      .references(() => xTargetAccounts.id, { onDelete: 'cascade' }),
    tweetId: text('tweet_id').notNull(),
    tweetText: text('tweet_text').notNull(),
    authorUsername: text('author_username').notNull(),
    tweetUrl: text('tweet_url').notNull(),
    postedAt: timestamp('posted_at', { mode: 'date' }).notNull(),
    discoveredAt: timestamp('discovered_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
    replyDeadline: timestamp('reply_deadline', { mode: 'date' }).notNull(),
    status: xMonitoredTweetStatusEnum('status').notNull().default('pending'),
  },
  (table) => [
    unique('x_monitored_tweets_user_tweet').on(table.userId, table.tweetId),
    index('xmt_user_status_deadline_idx').on(
      table.userId,
      table.status,
      table.replyDeadline,
    ),
  ],
);

/**
 * Content calendar for scheduled original X posts.
 * Enforces content mix: 40% metric, 30% educational, 20% engagement, 10% product.
 */
export const xContentCalendar = pgTable(
  'x_content_calendar',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull().default('x'), // 'x' | 'reddit' | 'linkedin' | ...
    scheduledAt: timestamp('scheduled_at', { mode: 'date' }).notNull(),
    contentType: text('content_type').notNull(), // 'metric' | 'educational' | 'engagement' | 'product' | 'thread'
    status: xContentCalendarStatusEnum('status').notNull().default('scheduled'),
    topic: text('topic'),
    draftId: text('draft_id').references(() => drafts.id),
    postedExternalId: text('posted_external_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('xcc_user_channel_status_scheduled_idx').on(
      t.userId,
      t.channel,
      t.status,
      t.scheduledAt,
    ),
  ],
);

/**
 * Tweet performance metrics sampled over time.
 * Bookmarks are the most important signal (algorithm fuel).
 */
export const xTweetMetrics = pgTable(
  'x_tweet_metrics',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tweetId: text('tweet_id').notNull(),
    impressions: integer('impressions').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    retweets: integer('retweets').notNull().default(0),
    replies: integer('replies').notNull().default(0),
    bookmarks: integer('bookmarks').notNull().default(0),
    quoteTweets: integer('quote_tweets').notNull().default(0),
    urlClicks: integer('url_clicks').notNull().default(0),
    profileClicks: integer('profile_clicks').notNull().default(0),
    sampledAt: timestamp('sampled_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('x_tweet_metrics_user_tweet').on(table.userId, table.tweetId),
    index('xtm_user_sampled_idx').on(table.userId, desc(table.sampledAt)),
  ],
);

/**
 * Daily snapshots of follower count for growth tracking.
 *
 * `snapshotDate` is a derived date column (UTC day) used for per-day uniqueness;
 * metrics cron runs hourly, but we only want one snapshot per user per day.
 */
export const xFollowerSnapshots = pgTable(
  'x_follower_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followerCount: integer('follower_count').notNull(),
    followingCount: integer('following_count').notNull(),
    tweetCount: integer('tweet_count').notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    snapshotAt: timestamp('snapshot_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('xfs_user_date_uq').on(t.userId, t.snapshotDate),
  ],
);

/**
 * Daily analytics summary computed from tweet metrics and follower snapshots.
 * Used by calendar planner to optimize content strategy.
 */
export const xAnalyticsSummary = pgTable(
  'x_analytics_summary',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { mode: 'date' }).notNull(),
    periodEnd: timestamp('period_end', { mode: 'date' }).notNull(),
    bestContentTypes: jsonb('best_content_types')
      .notNull()
      .$type<Array<{ type: string; avgBookmarks: number; avgImpressions: number; count: number }>>(),
    bestPostingHours: jsonb('best_posting_hours')
      .notNull()
      .$type<Array<{ hour: number; avgEngagement: number }>>(),
    audienceGrowthRate: real('audience_growth_rate').notNull().default(0),
    engagementRate: real('engagement_rate').notNull().default(0),
    totalImpressions: integer('total_impressions').notNull().default(0),
    totalBookmarks: integer('total_bookmarks').notNull().default(0),
    computedAt: timestamp('computed_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('xas_user_computed_idx').on(t.userId, desc(t.computedAt)),
    uniqueIndex('xas_user_period_uq').on(t.userId, t.periodStart, t.periodEnd),
  ],
);

/**
 * Platform-generic aliases for code that doesn't need to be X-specific.
 * The underlying DB tables keep their x_* names until a manual migration renames them.
 */
export const contentCalendar = xContentCalendar;
export const analyticsSummary = xAnalyticsSummary;
export const targetAccounts = xTargetAccounts;
export const monitoredContent = xMonitoredTweets;
