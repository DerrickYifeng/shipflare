import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Design-partner invite allowlist.
 *
 * Gates `signIn` callback in `src/lib/auth/index.ts`. The
 * `SUPER_ADMIN_EMAIL` env var is always allowed regardless of this
 * table — see `src/lib/auth/allowlist.ts`.
 *
 * Email values MUST be normalized (lowercased + trimmed) before
 * insert; the gate compares against normalized values too.
 */
export const allowedEmails = pgTable(
  'allowed_emails',
  {
    email: text('email').primaryKey(),
    invitedAt: timestamp('invited_at', { mode: 'date' }).defaultNow().notNull(),
    invitedBy: text('invited_by').notNull(),
    note: text('note'),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
  },
  (t) => [index('allowed_emails_revoked_idx').on(t.revokedAt)],
);

export type AllowedEmail = typeof allowedEmails.$inferSelect;
export type NewAllowedEmail = typeof allowedEmails.$inferInsert;
