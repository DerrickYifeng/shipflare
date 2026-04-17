import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
  boolean,
  jsonb,
  primaryKey,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AdapterAccountType } from 'next-auth/adapters';

/**
 * Auth.js v5 compatible schema using Drizzle adapter conventions.
 * Column names MUST match @auth/drizzle-adapter expectations.
 * See: https://authjs.dev/getting-started/adapters/drizzle
 */

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  githubId: text('github_id'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});

export const accounts = pgTable(
  'accounts',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    // TODO(security): encrypt at rest — these columns currently store GitHub
    // OAuth tokens in plaintext, inconsistent with the `channels` table's
    // envelope-encrypted `oauth_token_encrypted` / `refresh_token_encrypted`
    // strategy. Tracking in audit/audit-synthesis.md Theme 4 (Security) and
    // CLAUDE.md → "Security TODO".
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
    index('accounts_user_idx').on(account.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('sessionToken').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

/**
 * User automation preferences.
 * Controls auto-approve thresholds, posting schedule, content mix, and notifications.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    autoApproveEnabled: boolean('auto_approve_enabled').notNull().default(false),
    autoApproveThreshold: real('auto_approve_threshold').notNull().default(0.85),
    autoApproveTypes: jsonb('auto_approve_types')
      .notNull()
      .$type<string[]>()
      .default(['reply']),
    maxAutoApprovalsPerDay: integer('max_auto_approvals_per_day')
      .notNull()
      .default(10),
    postingHoursUtc: jsonb('posting_hours_utc')
      .notNull()
      .$type<number[]>()
      .default([14, 17, 21]),
    contentMixMetric: integer('content_mix_metric').notNull().default(40),
    contentMixEducational: integer('content_mix_educational').notNull().default(30),
    contentMixEngagement: integer('content_mix_engagement').notNull().default(20),
    contentMixProduct: integer('content_mix_product').notNull().default(10),
    notifyOnNewDraft: boolean('notify_on_new_draft').notNull().default(true),
    notifyOnAutoApprove: boolean('notify_on_auto_approve').notNull().default(true),
    timezone: text('timezone').notNull().default('America/Los_Angeles'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('user_preferences_user_id').on(table.userId),
    // CHECK is also enforced at DB level via migration 0014_wave2_constraints.
    check(
      'user_preferences_content_mix_sum',
      sql`${table.contentMixMetric} + ${table.contentMixEducational} + ${table.contentMixEngagement} + ${table.contentMixProduct} = 100`,
    ),
  ],
);
