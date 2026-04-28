import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  real,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { desc, sql } from 'drizzle-orm';
import { users } from './users';
import { threads } from './channels';
import { planItems } from './plan-items';

export const draftStatusEnum = pgEnum('draft_status', [
  'pending',
  'approved',
  'skipped',
  'posted',
  'failed',
  'flagged',
  'needs_revision',
  'handed_off',
]);

export const postStatusEnum = pgEnum('post_status', [
  'posted',
  'removed',
  'verified',
]);

export const drafts = pgTable(
  'drafts',
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
    status: draftStatusEnum('status').notNull().default('pending'),
    draftType: text('draft_type').notNull().default('reply'), // 'reply' | 'original_post'
    postTitle: text('post_title'), // for original_post type
    replyBody: text('reply_body').notNull(),
    confidenceScore: real('confidence_score').notNull(),
    whyItWorks: text('why_it_works'),
    ftcDisclosure: text('ftc_disclosure'),
    reviewVerdict: text('review_verdict'), // 'PASS' | 'FAIL' | 'REVISE'
    reviewScore: real('review_score'),
    reviewJson: jsonb('review_json'), // { checks, issues, suggestions }
    engagementDepth: integer('engagement_depth').notNull().default(0),
    planItemId: text('plan_item_id').references(() => planItems.id, {
      onDelete: 'set null',
    }),
    media: jsonb('media')
      .default([])
      .$type<Array<{ url: string; type: 'image' | 'gif' | 'video'; alt?: string }>>(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('drafts_user_status_created_idx').on(
      t.userId,
      t.status,
      desc(t.createdAt),
    ),
    index('drafts_plan_item_idx').on(t.planItemId),
  ],
);

export const posts = pgTable(
  'posts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    status: postStatusEnum('status').notNull().default('posted'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    community: text('community').notNull(),
    postedAt: timestamp('posted_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('posts_user_posted_idx').on(t.userId, desc(t.postedAt)),
    index('posts_user_community_posted_idx').on(t.userId, t.community, desc(t.postedAt)),
    uniqueIndex('posts_platform_external_uq').on(t.platform, t.externalId).where(sql`"external_id" IS NOT NULL`),
  ],
);

export const healthScores = pgTable(
  'health_scores',
  {
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
  },
  (t) => [
    index('health_scores_user_calculated_idx').on(
      t.userId,
      desc(t.calculatedAt),
    ),
  ],
);

export const activityEvents = pgTable(
  'activity_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    metadataJson: jsonb('metadata_json'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    index('activity_events_user_type_created_idx').on(t.userId, t.eventType, desc(t.createdAt)),
  ],
);
