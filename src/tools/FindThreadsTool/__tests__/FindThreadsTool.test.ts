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
import { threads } from '@/lib/db/schema';

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
  upvotes: number | null;
  commentCount: number | null;
  relevanceScore: number;
  postedAt: Date | null;
  discoveredAt: Date;
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
    upvotes: r.upvotes ?? null,
    commentCount: r.commentCount ?? null,
    relevanceScore: r.relevanceScore ?? 0.5,
    postedAt: r.postedAt ?? new Date(now - 60 * 60_000),
    discoveredAt: r.discoveredAt ?? new Date(now - 30 * 60_000),
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
      { id: 't-a', userId: 'user-1', title: 'mine A', relevanceScore: 0.9 },
      { id: 't-b', userId: 'user-2', title: 'theirs B', relevanceScore: 0.9 },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({}, ctx);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]!.threadId).toBe('t-a');
  });

  it('applies the platforms filter when supplied', async () => {
    seed(store, [
      { id: 't-r', platform: 'reddit', relevanceScore: 0.8 },
      { id: 't-x', platform: 'x', relevanceScore: 0.8 },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await findThreadsTool.execute({ platforms: ['x'] }, ctx);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]!.platform).toBe('x');
  });

  it('filters by minRelevance client-side', async () => {
    seed(store, [
      { id: 't-lo', relevanceScore: 0.2 },
      { id: 't-hi', relevanceScore: 0.9 },
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

  it('serializes Date fields as ISO strings', async () => {
    const posted = new Date('2026-04-20T10:00:00Z');
    const discovered = new Date('2026-04-20T11:00:00Z');
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
