import {
  pgTable,
  text,
  timestamp,
  real,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { desc, sql } from 'drizzle-orm';
import { users } from './users';
import { xContentCalendarItemStateEnum } from './x-growth';

export const channels = pgTable(
  'channels',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().default('reddit'),
    username: text('username').notNull(),
    // Nullable to support handoff-mode platforms (e.g. Reddit, where
    // ShipFlare uses appOnly() reads + clipboard handoff for posting and
    // never holds the founder's OAuth token). X / future OAuth-required
    // platforms continue to populate both columns.
    oauthTokenEncrypted: text('oauth_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    tokenExpiresAt: timestamp('token_expires_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('channels_user_platform_uq').on(t.userId, t.platform),
  ],
);

export const threads = pgTable(
  'threads',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    platform: text('platform').notNull().default('reddit'),
    /**
     * Reddit-only: subreddit name (no `r/` prefix). NULL for X threads
     * because X has no equivalent of subreddits — the previous
     * `notNull()` constraint forced producers to write `'x'` as a
     * placeholder, which the drafting LLM occasionally then handed to
     * `get_subreddit_rules` and 404'd against the Reddit API. Renderers
     * MUST treat null as "no community label" and fall back on the
     * platform name (or omit the badge).
     */
    community: text('community'),
    title: text('title').notNull(),
    url: text('url').notNull(),
    body: text('body'),
    author: text('author'),
    upvotes: integer('upvotes').default(0),
    commentCount: integer('comment_count').default(0),
    /**
     * Discovery v3: scout agent's confidence (0..1) and 1-2 sentence
     * rationale. Populated by the `discovery-scan` path running the
     * discovery-agent.
     */
    scoutConfidence: real('scout_confidence'),
    scoutReason: text('scout_reason'),
    isLocked: boolean('is_locked').default(false),
    isArchived: boolean('is_archived').default(false),
    postedAt: timestamp('posted_at', { mode: 'date' }),
    discoveredAt: timestamp('discovered_at', { mode: 'date' })
      .defaultNow()
      .notNull(),
    state: xContentCalendarItemStateEnum('state').notNull().default('queued'),
    failureReason: text('failure_reason'),
    retryCount: integer('retry_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { mode: 'date' }),
    sourceJobId: text('source_job_id'),
    // Discovery conversational rewrite (2026-04-26): engagement signal +
    // repost canonicalization. Populated by `persist_queue_threads`.
    likesCount: integer('likes_count'),
    repostsCount: integer('reposts_count'),
    repliesCount: integer('replies_count'),
    viewsCount: integer('views_count'),
    isRepost: boolean('is_repost').notNull().default(false),
    originalUrl: text('original_url'),
    originalAuthorUsername: text('original_author_username'),
    surfacedVia: jsonb('surfaced_via').$type<string[] | null>(),
    // Discovery v4 (2026-05-03): merge of judging-opportunity into
    // judging-thread-quality. Discovery now decides whether the thread
    // earns a product mention at the same time it scores ICP fit.
    canMentionProduct: boolean('can_mention_product'),
    mentionSignal: text('mention_signal'),
    // Author signal (2026-05-04): bio + follower count from xAI's enriched
    // search response. Used by judging-thread-quality to filter competitor /
    // engagement-pod accounts and by drafting-reply to calibrate voice
    // (small account → more first-person; large account → punchier).
    authorBio: text('author_bio'),
    authorFollowers: integer('author_followers'),
    // Conversation context (migration 0020): quoted-tweet body/author when
    // the surfaced tweet is a quote-tweet, or parent body/author when it's
    // a reply in a thread. Used by drafting-reply to write context-aware
    // replies. judging-thread-quality intentionally does NOT read these
    // (recall > precision — see 2026-05-04 spec).
    quotedText: text('quoted_text'),
    quotedAuthor: text('quoted_author'),
    inReplyToText: text('in_reply_to_text'),
    inReplyToAuthor: text('in_reply_to_author'),
  },
  (t) => [
    index('threads_user_discovered_idx').on(t.userId, desc(t.discoveredAt)),
    index('threads_user_platform_author_idx').on(
      t.userId,
      t.platform,
      t.author,
    ),
    uniqueIndex('threads_user_platform_external_uq').on(
      t.userId,
      t.platform,
      t.externalId,
    ),
  ],
);

export const channelPosts = pgTable(
  'channel_posts',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    text: text('text').notNull(),
    type: text('type').$type<'post' | 'reply'>().notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    uniqueIndex('channel_posts_channel_external_uq').on(t.channelId, t.externalId),
    index('channel_posts_channel_posted_idx').on(t.channelId, desc(t.postedAt)),
    check('channel_posts_type_chk', sql`${t.type} IN ('post', 'reply')`),
  ],
);
