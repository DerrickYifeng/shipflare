import { db } from '@/lib/db';
import { accounts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { maybeDecrypt } from '@/lib/encryption';
import type { GitHubRepo } from '@/types/code-scanner';

const log = createLogger('lib:github');

/**
 * Get the user's GitHub OAuth access token from the accounts table.
 * Tokens are stored envelope-encrypted; legacy plaintext rows are returned as-is
 * so the backfill script can upgrade them without breaking live users.
 */
export async function getGitHubToken(userId: string): Promise<string | null> {
  const result = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.provider, 'github'),
      ),
    )
    .limit(1);

  return maybeDecrypt(result[0]?.accessToken ?? null);
}

/**
 * List the user's GitHub repos, sorted by most recently pushed.
 * Default GitHub OAuth scope = public repos only.
 */
export async function listUserRepos(token: string): Promise<GitHubRepo[]> {
  const res = await fetch(
    'https://api.github.com/user/repos?sort=pushed&per_page=30&type=owner',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    log.error(`GitHub /user/repos failed: ${res.status}`);
    throw new Error(`GitHub API error: ${res.status}`);
  }

  const repos = (await res.json()) as Array<{
    full_name: string;
    name: string;
    description: string | null;
    homepage: string | null;
    language: string | null;
    stargazers_count: number;
    pushed_at: string;
  }>;

  return repos.map((r) => ({
    fullName: r.full_name,
    name: r.name,
    description: r.description,
    homepage: r.homepage,
    language: r.language,
    stargazersCount: r.stargazers_count,
    pushedAt: r.pushed_at,
  }));
}

/**
 * Revoke the OAuth grant for this user on GitHub's side.
 *
 * Without this step, deleting a user only cleans our DB; GitHub still shows
 * ShipFlare as an authorized app, so the next "Sign in with GitHub" skips the
 * consent screen and silently relinks the user, which reads as "GitHub is
 * still connected" post-deletion. See CLAUDE.md → Security TODO.
 *
 * Fails open: if the token is already invalid, or GitHub is unreachable, we
 * log and return false so the caller can still delete the account. The
 * alternative (blocking deletion) creates an escape hatch for users whose
 * token has already expired.
 *
 * Endpoint: DELETE /applications/{client_id}/grant
 *   Auth: HTTP Basic with client_id:client_secret
 *   Body: { access_token }
 *   Docs: https://docs.github.com/rest/apps/oauth-applications#delete-an-app-authorization
 */
export async function revokeGitHubGrant(accessToken: string): Promise<boolean> {
  const clientId = process.env.GITHUB_ID;
  const clientSecret = process.env.GITHUB_SECRET;
  if (!clientId || !clientSecret) {
    log.warn('revokeGitHubGrant: GITHUB_ID / GITHUB_SECRET not configured');
    return false;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const res = await fetch(
      `https://api.github.com/applications/${clientId}/grant`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    // 204 = revoked. 404 = already revoked / not found. 422 = invalid token.
    // We treat all of these as "grant is not live anymore".
    if (res.status === 204 || res.status === 404 || res.status === 422) {
      return true;
    }
    log.warn(`revokeGitHubGrant: unexpected status ${res.status}`);
    return false;
  } catch (err) {
    log.error(`revokeGitHubGrant failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
