/**
 * Seed the design-partner allowlist.
 *
 * Idempotent: each invocation upserts rows with `ON CONFLICT (email) DO NOTHING`.
 * Always inserts `SUPER_ADMIN_EMAIL` so the founder can sign in even if the
 * `/admin/invites` UI is broken.
 *
 * Usage:
 *
 *   DATABASE_URL=postgresql://... \
 *   SUPER_ADMIN_EMAIL=founder@example.com \
 *   bun run scripts/seed-allowed-emails.ts foo@bar.com baz@qux.com
 *
 * Each positional arg is normalized (lowercased + trimmed) before insert.
 */
import { db } from '../src/lib/db';
import { allowedEmails } from '../src/lib/db/schema';
import { normalizeEmail } from '../src/lib/auth/allowlist';

async function main(): Promise<void> {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  if (!adminEmail) {
    console.error(
      'seed-allowed-emails: SUPER_ADMIN_EMAIL env var is required.\n' +
        '  Example: SUPER_ADMIN_EMAIL=founder@example.com bun run scripts/seed-allowed-emails.ts',
    );
    process.exit(1);
  }
  const normalizedAdmin = normalizeEmail(adminEmail);

  const argEmails = process.argv
    .slice(2)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizeEmail(raw));

  const all = Array.from(new Set([normalizedAdmin, ...argEmails]));

  console.log(`seed-allowed-emails: inserting ${all.length} email(s)`);
  for (const email of all) {
    console.log(`  - ${email}`);
  }

  for (const email of all) {
    await db
      .insert(allowedEmails)
      .values({ email, invitedBy: normalizedAdmin })
      .onConflictDoNothing({ target: allowedEmails.email });
  }

  console.log('✓ Done.');
}

main()
  .catch((err) => {
    console.error('seed-allowed-emails failed:', err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
