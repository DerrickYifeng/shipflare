import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { desc } from 'drizzle-orm';
import { users } from './users';
import { products } from './products';
import { strategicPaths } from './strategic-paths';

export const planTriggerEnum = pgEnum('plan_trigger', [
  'onboarding',
  'weekly',
  'manual',
]);

/**
 * Lightweight header produced by one Tactical Planner run. Groups the
 * `plan_items` scheduled for a single week. Multiple plans per user
 * accumulate over time — superseded ones are kept for audit.
 */
export const plans = pgTable(
  'plans',
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
    strategicPathId: text('strategic_path_id').references(() => strategicPaths.id, {
      onDelete: 'set null',
    }),
    trigger: planTriggerEnum('trigger').notNull(),
    weekStart: timestamp('week_start', { mode: 'date' }).notNull(),
    generatedAt: timestamp('generated_at', { mode: 'date' }).defaultNow().notNull(),
    notes: text('notes'),
    usageSummary: jsonb('usage_summary'),
  },
  (t) => [
    index('plans_user_week_idx').on(t.userId, desc(t.weekStart)),
    index('plans_product_idx').on(t.productId),
  ],
);
