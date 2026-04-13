import { db } from '@/lib/db';
import { accounts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import type { GitHubRepo } from '@/types/code-scanner';

const log = createLogger('lib:github');

/**
 * Get the user's GitHub OAuth access token from the accounts table.
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

  return result[0]?.accessToken ?? null;
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
