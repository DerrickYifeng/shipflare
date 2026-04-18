import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users';
import { products } from './products';

/**
 * One row per channel-week. Records the weekly thesis, pillar, fallback mode,
 * and the derivation signal (milestone | top_reply_ratio | fallback).
 *
 * Referenced by `xContentCalendar.theme_id`; each calendar row belongs to
 * exactly one weekly theme.
 */
export const weeklyThemes = pgTable(
  'weekly_themes',
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
    channel: text('channel').notNull(),
    weekStart: timestamp('week_start', { mode: 'date' }).notNull(),
    thesis: text('thesis').notNull(),
    pillar: text('pillar'),
    thesisSource: text('thesis_source').notNull(),
    fallbackMode: text('fallback_mode'),
    milestoneContext: text('milestone_context'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    unique('weekly_themes_user_channel_week').on(t.userId, t.channel, t.weekStart),
    index('weekly_themes_user_channel_idx').on(t.userId, t.channel),
  ],
);
