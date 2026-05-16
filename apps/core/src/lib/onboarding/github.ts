// GitHub helpers for the onboarding flow. Reads the user's GitHub OAuth
// access token from Better Auth's `account` table (stored on first sign-in
// with `providerId='github'`), then hits the GitHub REST API directly.

import type { DB } from "@shipflare/db";
import { account, eq, and } from "@shipflare/db";

export interface GithubRepo {
  fullName: string;
  name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazersCount: number;
  pushedAt: string;
}

export async function getGitHubToken(
  db: DB,
  userId: string,
): Promise<string | null> {
  const row = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .get();
  return row?.accessToken ?? null;
}

export async function listUserRepos(token: string): Promise<GithubRepo[]> {
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipFlare/1.0",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${await res.text()}`);
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
