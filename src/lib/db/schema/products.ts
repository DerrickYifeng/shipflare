import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

export const products = pgTable('products', {
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
  lifecyclePhase: text('lifecycle_phase').notNull().default('pre_launch'),
  seoAuditJson: jsonb('seo_audit_json'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});
