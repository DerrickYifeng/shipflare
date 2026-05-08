import { describe, it, expect, vi, beforeEach } from 'vitest';

// `redirect` from next/navigation throws an internal error in real
// runtime; we replace it with a sentinel-throwing mock so tests can
// match on the exact target path.
class MockRedirect extends Error {
  constructor(public path: string) {
    super(`redirect:${path}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new MockRedirect(path);
  },
}));

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const draftLookupMock = vi.fn();
const threadLookupMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      drafts: { findFirst: () => draftLookupMock() },
      threads: { findFirst: () => threadLookupMock() },
    },
  },
}));

vi.mock('@/lib/db/schema', () => ({
  drafts: { id: 'id', userId: 'userId' },
  threads: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conds: unknown[]) => ({ conds }),
}));

vi.mock('@/lib/platform-config', () => ({
  PLATFORMS: { reddit: { id: 'reddit' } },
}));

// HandoffClient is a client component imported by the server page; we
// stub it so the page can render to a string in node without bringing in
// the full client tree.
vi.mock('../_components/handoff-client', () => ({
  HandoffClient: () => null,
}));

beforeEach(() => {
  authUserId = 'user-1';
  draftLookupMock.mockReset();
  threadLookupMock.mockReset();
});

async function callPage(draftId = 'd-1'): Promise<unknown> {
  const { default: Page } = await import('../page');
  return Page({ params: Promise.resolve({ draftId }) });
}

function expectRedirect(promise: Promise<unknown>, path: string) {
  return expect(promise).rejects.toMatchObject({
    path,
  });
}

describe('RedditHandoffPage URL validation', () => {
  it('redirects to invalid_thread_url when thread.url host is not reddit.com', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'pending',
      draftType: 'reply',
      threadId: 't-1',
      replyBody: 'hi',
    });
    threadLookupMock.mockResolvedValueOnce({
      id: 't-1',
      platform: 'reddit',
      url: 'https://evil.example.com/r/SaaS/comments/1abc/test',
      title: 'x',
      community: 'SaaS',
      author: 'foo',
    });
    await expectRedirect(callPage(), '/today?notice=invalid_thread_url');
  });

  it('redirects to invalid_thread_url when thread.url is unparseable garbage', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'pending',
      draftType: 'reply',
      threadId: 't-1',
      replyBody: 'hi',
    });
    threadLookupMock.mockResolvedValueOnce({
      id: 't-1',
      platform: 'reddit',
      url: 'http://[notavalidurl',
      title: 'x',
      community: 'SaaS',
      author: 'foo',
    });
    await expectRedirect(callPage(), '/today?notice=invalid_thread_url');
  });

  it('accepts a relative reddit thread URL (joined to www.reddit.com)', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'pending',
      draftType: 'reply',
      threadId: 't-1',
      replyBody: 'hi',
    });
    threadLookupMock.mockResolvedValueOnce({
      id: 't-1',
      platform: 'reddit',
      url: '/r/SaaS/comments/1abc/test',
      title: 'x',
      community: 'SaaS',
      author: 'foo',
    });
    // No throw → page rendered without redirecting.
    await expect(callPage()).resolves.toBeDefined();
  });

  it('accepts old.reddit.com host', async () => {
    draftLookupMock.mockResolvedValueOnce({
      id: 'd-1',
      userId: 'user-1',
      status: 'pending',
      draftType: 'reply',
      threadId: 't-1',
      replyBody: 'hi',
    });
    threadLookupMock.mockResolvedValueOnce({
      id: 't-1',
      platform: 'reddit',
      url: 'https://old.reddit.com/r/SaaS/comments/1abc/test',
      title: 'x',
      community: 'SaaS',
      author: 'foo',
    });
    await expect(callPage()).resolves.toBeDefined();
  });
});
