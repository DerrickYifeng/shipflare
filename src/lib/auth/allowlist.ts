import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { allowedEmails } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth:allowlist');

/**
 * Normalize an email for allowlist comparison: lowercase + trim.
 *
 * GitHub may return mixed-case emails depending on how the user
 * registered theirs; the allowlist stores normalized values, so the
 * sign-in gate must normalize too. Same function is reused at
 * insert-time (admin form, seed script) to keep the table canonical.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Returns the normalized super-admin email, or null if the
 * `SUPER_ADMIN_EMAIL` env var is unset/empty.
 *
 * Calling code MUST treat null as "no super admin configured" — never
 * fall through to permissive behavior. A missing env var is itself a
 * failure mode (see `isEmailAllowed` which logs WARN once per process).
 */
export function getSuperAdminEmail(): string | null {
  const raw = process.env.SUPER_ADMIN_EMAIL;
  if (!raw || raw.trim() === '') return null;
  return normalizeEmail(raw);
}

let superAdminWarnLogged = false;

/**
 * Returns true if `email` is permitted to sign in. The gate is:
 *
 *   1. `email === SUPER_ADMIN_EMAIL` → always allowed (safety net so
 *      the founder can never be locked out by an empty/broken table).
 *   2. Otherwise, must exist in `allowed_emails` with `revoked_at IS NULL`.
 *
 * Caller is responsible for normalizing `email` first; this function
 * does not re-normalize because the caller usually has the raw value
 * available for logging too.
 */
export async function isEmailAllowed(normalizedEmail: string): Promise<boolean> {
  if (!normalizedEmail) return false;

  const superAdmin = getSuperAdminEmail();
  if (superAdmin === null) {
    if (!superAdminWarnLogged) {
      log.warn(
        'SUPER_ADMIN_EMAIL is not set — no founder bypass available. ' +
          'Set it in env or you may lock yourself out.',
      );
      superAdminWarnLogged = true;
    }
  } else if (normalizedEmail === superAdmin) {
    return true;
  }

  const [row] = await db
    .select({ email: allowedEmails.email })
    .from(allowedEmails)
    .where(
      and(
        eq(allowedEmails.email, normalizedEmail),
        isNull(allowedEmails.revokedAt),
      ),
    )
    .limit(1);

  return Boolean(row);
}
