import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { products } from './products';

/**
 * Shared 6-phase taxonomy. Produced by `derivePhase()` from
 * `products.state + launchDate + launchedAt`. Consumed by the Strategic
 * Planner (snapshots the phase at generation time) and by `plan_items`
 * (records the phase active when the item was scheduled).
 */
export const launchPhaseEnum = pgEnum('launch_phase', [
  'foundation',
  'audience',
  'momentum',
  'launch',
  'compound',
  'steady',
]);

/**
 * Durable narrative arc for a product's 6-week pre-launch (or 30-day
 * post-launch) window. The Strategic Planner generates one row per
 * onboarding commit or phase change. Only one row per user is active at
 * any time (enforced by `strategic_paths_active_uq`).
 */
export const strategicPaths = pgTable(
  'strategic_paths',
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
    isActive: boolean('is_active').notNull().default(true),
    generatedAt: timestamp('generated_at', { mode: 'date' }).defaultNow().notNull(),

    phase: launchPhaseEnum('phase').notNull(),
    launchDate: timestamp('launch_date', { mode: 'date' }),
    launchedAt: timestamp('launched_at', { mode: 'date' }),

    narrative: text('narrative').notNull(),
    milestones: jsonb('milestones').notNull(),
    thesisArc: jsonb('thesis_arc').notNull(),
    contentPillars: jsonb('content_pillars').notNull(),
    channelMix: jsonb('channel_mix').notNull(),
    phaseGoals: jsonb('phase_goals').notNull(),

    usageSummary: jsonb('usage_summary'),
  },
  (t) => [
    uniqueIndex('strategic_paths_active_uq')
      .on(t.userId)
      .where(sql`is_active = true`),
    index('strategic_paths_user_idx').on(t.userId),
    index('strategic_paths_product_idx').on(t.productId),
  ],
);
