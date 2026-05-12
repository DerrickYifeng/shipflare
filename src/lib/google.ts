import { db } from '@/lib/db';
import { accounts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { maybeDecrypt } from '@/lib/encryption';

const log = createLogger('lib:google');

/**
 * Get the user's Google OAuth access token from the accounts table.
 * Tokens are stored envelope-encrypted via the adapter wrap in
 * src/lib/auth/index.ts; legacy plaintext rows are returned as-is.
 */
export async function getGoogleToken(userId: string): Promise<string | null> {
  const result = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.provider, 'google'),
      ),
    )
    .limit(1);

  return maybeDecrypt(result[0]?.accessToken ?? null);
}

/**
 * Revoke the OAuth grant for this user on Google's side.
 *
 * Without this step, deleting a user only cleans our DB; Google still lists
 * ShipFlare under "Third-party apps with account access", so the next
 * "Sign in with Google" silently re-uses the same grant. We only request
 * openid/email/profile, but revoking on deletion is consistent with the
 * GitHub flow (see src/lib/github.ts → revokeGitHubGrant) and good hygiene.
 *
 * Fails open: token already invalid, network blip, or non-2xx response →
 * log + return false. Caller (DELETE /api/account) treats this as
 * best-effort and continues with DB deletion regardless.
 *
 * Endpoint: POST https://oauth2.googleapis.com/revoke
 *   Auth: none (token is in the body/query)
 *   Body: token=<access_token>  (application/x-www-form-urlencoded)
 *   Docs: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 */
export async function revokeGoogleGrant(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: accessToken }).toString(),
      signal: AbortSignal.timeout(10_000),
    });

    // 200 = revoked. 400 with invalid_token = already revoked.
    // We treat both as "grant is no longer live".
    if (res.ok) return true;
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      if (text.includes('invalid_token')) return true;
    }
    log.warn(`revokeGoogleGrant: unexpected status ${res.status}`);
    return false;
  } catch (err) {
    log.error(
      `revokeGoogleGrant failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
