import {
  pgTable,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { products } from './products';

/**
 * Per-product top-N Reddit subreddits surfaced by the kickoff research
 * pass and (eventually) hand-edited by the founder.
 *
 * Rows are populated by the "Reddit subreddit research at kickoff"
 * pipeline: an xAI call ranks subreddits by ICP fit, the tactical
 * planner then binds each Reddit `content_post` plan_item to one of
 * these subreddits at plan-time. This eliminates the architectural gap
 * where Reddit posts had no target subreddit (and `dispatchApprove`
 * threw 500s).
 *
 * UNIQUE (productId, subreddit) prevents the research pass and the
 * founder's "add subreddit" UI from racing each other into duplicate
 * rows. ON DELETE CASCADE on `product_id` / `user_id` keeps cleanup
 * automatic when a product (or user) is deleted.
 */
export const productRedditChannels = pgTable(
  'product_reddit_channels',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Subreddit name without the `r/` prefix. */
    subreddit: text('subreddit').notNull(),
    memberCount: integer('member_count'),
    fitScore: real('fit_score'),
    rulesSummary: text('rules_summary'),
    /**
     * `{ postsLast7d, commentsLast7d, medianUpvotes }` — jsonb so we
     * can extend the activity shape (e.g. peak posting hours) without
     * a migration.
     */
    activity: jsonb('activity').$type<{
      postsLast7d?: number;
      commentsLast7d?: number;
      medianUpvotes?: number;
    } | null>(),
    /** Display rank 1..N. Sort order in UI and round-robin. */
    rank: integer('rank').notNull().default(99),
    /** `'auto'` (research-discovered) or `'manual'` (founder-added). */
    source: text('source').notNull().default('auto'),
    /** Soft-hide. */
    disabled: boolean('disabled').notNull().default(false),
    /**
     * Updated by the planner each time it binds a content_post to this
     * subreddit. Used for round-robin spread across subreddits.
     */
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('product_reddit_channels_product_subreddit_uq').on(
      t.productId,
      t.subreddit,
    ),
    index('product_reddit_channels_product_active_idx').on(
      t.productId,
      t.disabled,
      t.rank,
    ),
  ],
);

export type ProductRedditChannel = typeof productRedditChannels.$inferSelect;
export type NewProductRedditChannel = typeof productRedditChannels.$inferInsert;
