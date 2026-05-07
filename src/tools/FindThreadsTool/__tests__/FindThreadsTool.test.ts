/**
 * find_threads unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});
vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { findThreadsTool } from '../FindThreadsTool';
import { drafts, threads } from '@/lib/db/schema';

interface ThreadRow {
  id: string;
  userId: string;
  externalId: string;
  platform: string;
  community: string;
  title: string;
  url: string;
  body: string | null;
  author: string | null;
  authorBio: string | null;
  authorFollowers: number | null;
  upvotes: number | null;
  commentCount: number | null;
  scoutConfidence: number | null;
  postedAt: Date | null;
  discoveredAt: Date;
  canMentionProduct: boolean | null;
  mentionSignal: string | null;
}

function makeCtx(
  store: InMemoryStore,
  deps: Record<string, unknown>,
): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      if (key === 'db') return store.db as unknown as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

function seed(store: InMemoryStore, rows: Partial<ThreadRow>[]): void {
  const now = Date.now();
  const full: ThreadRow[] = rows.map((r, i) => ({
    id: r.id ?? `thread-${i}`,
    userId: r.userId ?? 'user-1',
    externalId: r.externalId ?? `ext-${i}`,
    platform: r.platform ?? 'reddit',
    community: r.community ?? 'SideProject',
    title: r.title ?? `thread ${i}`,
    url: r.url ?? `https://reddit.com/comments/ext-${i}`,
    body: r.body ?? null,
    author: r.author ?? null,
    authorBio: r.authorBio ?? null,
    authorFollowers: r.authorFollowers ?? null,
    upvotes: r.upvotes ?? null,
    commentCount: r.commentCount ?? null,
    scoutConfidence: r.scoutConfidence ?? 0.5,
    postedAt: r.postedAt ?? new Date(now - 60 * 60_000),
    discoveredAt: r.discoveredAt ?? new Date(now - 30 * 60_000),
    canMentionProduct: r.canMentionProduct ?? null,
    mentionSignal: r.mentionSignal ?? null,
  }));
  store.register<ThreadRow>(threads, full);
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
});

describe('findThreadsTool', () => {
  it('returns recent threads scoped to the caller userId', async () => {
    seed(store, [
      { id: 't-a', userId: 'user-1', title: 'mine A', scoutConfidence: 0.9 },
      { id: 't-b', userId: 'user-2', title: 'theirs B', scoutConfidence: 0.9 },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({}, ctx);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]!.threadId).toBe('t-a');
  });

  it('applies the platforms filter when supplied', async () => {
    seed(store, [
      { id: 't-r', platform: 'reddit', scoutConfidence: 0.8 },
      { id: 't-x', platform: 'x', scoutConfidence: 0.8 },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({ platforms: ['x'] }, ctx);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]!.platform).toBe('x');
  });

  it('filters by minRelevance client-side', async () => {
    seed(store, [
      { id: 't-lo', scoutConfidence: 0.2 },
      { id: 't-hi', scoutConfidence: 0.9 },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({ minRelevance: 0.5 }, ctx);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]!.threadId).toBe('t-hi');
  });

  it('rejects an invalid limit via the schema', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { limit: 10_000 } as any;
    const parse = findThreadsTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('returns canMentionProduct + mentionSignal on each row', async () => {
    seed(store, [
      {
        id: 't-mention-1',
        platform: 'x',
        community: '@x',
        title: 't',
        url: 'https://x.com/u/status/1',
        canMentionProduct: true,
        mentionSignal: 'tool_question',
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({ platforms: ['x'] }, ctx);
    const row = result.threads.find((r) => r.threadId.length > 0);
    expect(row?.canMentionProduct).toBe(true);
    expect(row?.mentionSignal).toBe('tool_question');
  });

  it('returns authorBio + authorFollowers on each row', async () => {
    seed(store, [
      {
        id: 't-author-1',
        platform: 'x',
        community: '@x',
        title: 't',
        url: 'https://x.com/u/status/1',
        authorBio: 'building shipflare — indie hacker',
        authorFollowers: 1234,
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({ platforms: ['x'] }, ctx);
    const row = result.threads.find((r) => r.threadId === 't-author-1');
    expect(row?.authorBio).toBe('building shipflare — indie hacker');
    expect(row?.authorFollowers).toBe(1234);
  });

  it('returns null authorBio + authorFollowers for legacy rows', async () => {
    seed(store, [
      {
        id: 't-legacy-1',
        platform: 'x',
        community: '@x',
        title: 't',
        url: 'https://x.com/u/status/1',
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({ platforms: ['x'] }, ctx);
    const row = result.threads.find((r) => r.threadId === 't-legacy-1');
    expect(row?.authorBio).toBeNull();
    expect(row?.authorFollowers).toBeNull();
  });

  it('excludes threads from authors replied to within the cooldown window', async () => {
    const NOW = new Date('2026-05-05T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    const USER = 'user-1';

    // Build thread rows directly so we can control author + discoveredAt.
    store.register<ThreadRow>(threads, [
      {
        id: 't_alice_old',
        userId: USER,
        externalId: 'e1',
        platform: 'x',
        community: '@x',
        title: 'alice old',
        url: 'https://x.com/alice/1',
        body: null,
        author: 'alice',
        authorBio: null,
        authorFollowers: null,
        upvotes: null,
        commentCount: null,
        scoutConfidence: 0.9,
        postedAt: null,
        discoveredAt: NOW,
        canMentionProduct: null,
        mentionSignal: null,
      },
      {
        id: 't_alice_new',
        userId: USER,
        externalId: 'e2',
        platform: 'x',
        community: '@x',
        title: 'alice new',
        url: 'https://x.com/alice/2',
        body: null,
        author: 'alice',
        authorBio: null,
        authorFollowers: null,
        upvotes: null,
        commentCount: null,
        scoutConfidence: 0.9,
        postedAt: null,
        discoveredAt: NOW,
        canMentionProduct: null,
        mentionSignal: null,
      },
      {
        id: 't_bob',
        userId: USER,
        externalId: 'e3',
        platform: 'x',
        community: '@x',
        title: 'bob',
        url: 'https://x.com/bob/1',
        body: null,
        author: 'bob',
        authorBio: null,
        authorFollowers: null,
        upvotes: null,
        commentCount: null,
        scoutConfidence: 0.9,
        postedAt: null,
        discoveredAt: NOW,
        canMentionProduct: null,
        mentionSignal: null,
      },
    ]);

    store.tables.set(drafts, [
      {
        id: 'd_alice_old',
        userId: USER,
        threadId: 't_alice_old',
        status: 'posted',
        draftType: 'reply',
        replyBody: 'hello alice',
        confidenceScore: 0.5,
        whyItWorks: null,
        ftcDisclosure: null,
        reviewVerdict: null,
        reviewScore: null,
        reviewJson: null,
        engagementDepth: 0,
        planItemId: null,
        media: [],
        postTitle: null,
        createdAt: recent,
        updatedAt: recent,
      },
    ] as never);

    const ctx = makeCtx(store, { userId: USER, productId: 'prod-1' });
    const out = await findThreadsTool.execute({ platforms: ['x'] }, ctx);

    const ids = out.threads.map((t) => t.threadId).sort();
    expect(ids).toEqual(['t_bob']);

    vi.useRealTimers();
  });

  it('serializes Date fields as ISO strings', async () => {
    // Use relative timestamps so the test stays inside any reasonable
    // windowMinutes filter regardless of when it runs.
    const now = Date.now();
    const posted = new Date(now - 60 * 60_000);     // 1h ago
    const discovered = new Date(now - 30 * 60_000); // 30min ago
    seed(store, [
      { id: 't-dates', postedAt: posted, discoveredAt: discovered },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute(
      { windowMinutes: 10_080 },
      ctx,
    );
    expect(result.threads[0]!.postedAt).toBe(posted.toISOString());
    expect(result.threads[0]!.discoveredAt).toBe(discovered.toISOString());
  });
});
