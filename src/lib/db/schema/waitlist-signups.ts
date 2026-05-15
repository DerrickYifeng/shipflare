import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// citext — case-insensitive text — for emails. Drizzle has no native
// citext, so we declare it as a customType backed by the Postgres type.
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

export const waitlistSignups = pgTable(
  'waitlist_signups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: citext('email').notNull().unique(),
    useCase: text('use_case'),
    referer: text('referer'), // 'denied' | 'landing' | 'no-email' | null
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    approvedBy: text('approved_by'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
    dismissedBy: text('dismissed_by'),
  },
  (t) => [
    index('waitlist_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.approvedAt} IS NULL AND ${t.dismissedAt} IS NULL`),
  ],
);

export type WaitlistSignup = typeof waitlistSignups.$inferSelect;
export type NewWaitlistSignup = typeof waitlistSignups.$inferInsert;
