import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@/core/types';

const cloneRepoMock = vi.fn();
const cleanupCloneMock = vi.fn();
const execFileAsyncMock = vi.fn();

vi.mock('@/services/code-scanner', () => ({
  cloneRepo: (...args: unknown[]) => cloneRepoMock(...args),
  cleanupClone: (...args: unknown[]) => cleanupCloneMock(...args),
}));

vi.mock('node:util', () => ({
  promisify: (_fn: unknown) => (...args: unknown[]) =>
    execFileAsyncMock(...args),
}));

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => dbSelectMock(),
        }),
      }),
    }),
  },
}));

const getGitHubTokenMock = vi.fn();
vi.mock('@/lib/github', () => ({
  getGitHubToken: (userId: string) => getGitHubTokenMock(userId),
}));

vi.mock('@/lib/db/schema', () => ({
  codeSnapshots: {
    __name: 'code_snapshots',
    userId: { __col: 'user_id' },
    productId: { __col: 'product_id' },
    repoFullName: { __col: 'repo_full_name' },
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

beforeEach(() => {
  cloneRepoMock.mockReset();
  cleanupCloneMock.mockReset();
  execFileAsyncMock.mockReset();
  dbSelectMock.mockReset();
  getGitHubTokenMock.mockReset();
});

const NUL = String.fromCharCode(0x00);
const RS = String.fromCharCode(0x1e);

const ctx = (): ToolContext => {
  const deps: Record<string, unknown> = {
    userId: 'user-1',
    productId: 'prod-1',
  };
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      // db is read directly via @/lib/db mock; if a tool asks for it through
      // the context, fall through to the global mock too.
      if (key === 'db') return {} as V;
      throw new Error(`no dep ${key}`);
    },
  };
};

describe('query_code_changes', () => {
  it('returns commits in the requested window with sha/title/body/atISO', async () => {
    dbSelectMock.mockResolvedValueOnce([{ repoFullName: 'org/repo' }]);
    getGitHubTokenMock.mockResolvedValueOnce('ghp_xxx');
    cloneRepoMock.mockResolvedValueOnce('/tmp/clone');
    // git log --since={sinceISO} --until={untilISO} --format=%H%x00%aI%x00%s%x00%b%x1e
    // Mock output: 2 commits, NUL-separated fields, RS-separated records, trailing RS.
    const log =
      [
        ['abc123', '2026-05-05T10:00:00Z', 'feat: ship X', 'body of commit 1'].join(NUL),
        ['def456', '2026-05-04T08:00:00Z', 'fix: bug Y', ''].join(NUL),
      ].join(RS) + RS;
    execFileAsyncMock.mockResolvedValueOnce({ stdout: log });

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    const result = await queryCodeChangesTool.execute(
      { sinceISO: '2026-05-04T00:00:00Z' },
      ctx(),
    );

    expect(result).toEqual([
      {
        kind: 'commit',
        sha: 'abc123',
        title: 'feat: ship X',
        body: 'body of commit 1',
        atISO: '2026-05-05T10:00:00Z',
      },
      {
        kind: 'commit',
        sha: 'def456',
        title: 'fix: bug Y',
        body: '',
        atISO: '2026-05-04T08:00:00Z',
      },
    ]);
    expect(cleanupCloneMock).toHaveBeenCalledWith('/tmp/clone');
  });

  it('caps body at 600 chars', async () => {
    dbSelectMock.mockResolvedValueOnce([{ repoFullName: 'org/repo' }]);
    getGitHubTokenMock.mockResolvedValueOnce('ghp_xxx');
    cloneRepoMock.mockResolvedValueOnce('/tmp/clone');
    const longBody = 'x'.repeat(1200);
    const log =
      ['sha1', '2026-05-05T10:00:00Z', 'subj', longBody].join(NUL) + RS;
    execFileAsyncMock.mockResolvedValueOnce({ stdout: log });

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    const result = await queryCodeChangesTool.execute(
      { sinceISO: '2026-05-04T00:00:00Z' },
      ctx(),
    );
    expect(result[0].body.length).toBe(600);
  });

  it('caps results at 50 commits', async () => {
    dbSelectMock.mockResolvedValueOnce([{ repoFullName: 'org/repo' }]);
    getGitHubTokenMock.mockResolvedValueOnce('ghp_xxx');
    cloneRepoMock.mockResolvedValueOnce('/tmp/clone');
    const records = Array.from({ length: 80 }, (_, i) =>
      ['sha' + i, '2026-05-05T10:00:00Z', 'subj' + i, ''].join(NUL),
    );
    execFileAsyncMock.mockResolvedValueOnce({ stdout: records.join(RS) + RS });

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    const result = await queryCodeChangesTool.execute(
      { sinceISO: '2026-05-04T00:00:00Z' },
      ctx(),
    );
    expect(result).toHaveLength(50);
  });

  it('returns empty list when there are no commits in window', async () => {
    dbSelectMock.mockResolvedValueOnce([{ repoFullName: 'org/repo' }]);
    getGitHubTokenMock.mockResolvedValueOnce('ghp_xxx');
    cloneRepoMock.mockResolvedValueOnce('/tmp/clone');
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '' });

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    const result = await queryCodeChangesTool.execute(
      { sinceISO: '2026-05-04T00:00:00Z' },
      ctx(),
    );
    expect(result).toEqual([]);
  });

  it('throws no_repo when code_snapshots row is missing', async () => {
    dbSelectMock.mockResolvedValueOnce([]);

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    await expect(
      queryCodeChangesTool.execute(
        { sinceISO: '2026-05-04T00:00:00Z' },
        ctx(),
      ),
    ).rejects.toThrow(/no_repo/);
  });

  it('throws no_github_token when GitHub OAuth was disconnected', async () => {
    dbSelectMock.mockResolvedValueOnce([{ repoFullName: 'org/repo' }]);
    getGitHubTokenMock.mockResolvedValueOnce(null);

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    await expect(
      queryCodeChangesTool.execute(
        { sinceISO: '2026-05-04T00:00:00Z' },
        ctx(),
      ),
    ).rejects.toThrow(/no_github_token/);
  });

  it('cleans up clone on error', async () => {
    dbSelectMock.mockResolvedValueOnce([{ repoFullName: 'org/repo' }]);
    getGitHubTokenMock.mockResolvedValueOnce('ghp_xxx');
    cloneRepoMock.mockResolvedValueOnce('/tmp/clone');
    execFileAsyncMock.mockRejectedValueOnce(new Error('git crash'));

    const { queryCodeChangesTool } = await import('../QueryCodeChangesTool');
    await expect(
      queryCodeChangesTool.execute(
        { sinceISO: '2026-05-04T00:00:00Z' },
        ctx(),
      ),
    ).rejects.toThrow();
    expect(cleanupCloneMock).toHaveBeenCalledWith('/tmp/clone');
  });
});
