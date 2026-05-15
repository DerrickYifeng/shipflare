-- Allowlist (controls who can sign up) + waitlist signups (public form).
-- See packages/db/src/schema.ts for the matching Drizzle definitions.

CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY NOT NULL,
  invitedBy TEXT NOT NULL,
  note TEXT,
  invitedAt INTEGER NOT NULL,
  revokedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_allowed_emails_revokedAt
  ON allowed_emails(revokedAt);

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  submittedAt INTEGER NOT NULL,
  approvedAt INTEGER,
  approvedBy TEXT,
  dismissedAt INTEGER,
  dismissedBy TEXT
);

CREATE INDEX IF NOT EXISTS idx_waitlist_signups_status
  ON waitlist_signups(approvedAt, dismissedAt);
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_submittedAt
  ON waitlist_signups(submittedAt DESC);
