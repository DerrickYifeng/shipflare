import { pgTable, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

export const products = pgTable(
  'products',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    url: text('url'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    keywords: text('keywords').array().notNull().default([]),
    valueProp: text('value_prop'),
    state: text('state').notNull().default('mvp'),
    launchDate: timestamp('launch_date', { mode: 'date' }),
    launchedAt: timestamp('launched_at', { mode: 'date' }),
    targetAudience: text('target_audience'),
    category: text('category'),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { mode: 'date' }),
    seoAuditJson: jsonb('seo_audit_json'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('products_user_uq').on(t.userId)],
);
