/**
 * draft_reply unit tests.
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

import { draftReplyTool } from '../Reply';
import { drafts, threads } from '@/lib/db/schema';

interface ThreadRow {
  id: string;
  userId: string;
  platform: string;
}
interface DraftRow {
  id: string;
  userId: string;
  threadId: string;
  status: string;
  draftType: string;
  replyBody: string;
  confidenceScore: number;
  whyItWorks: string | null;
  engagementDepth: number;
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

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
  store.register<ThreadRow>(threads, [
    { id: 't-1', userId: 'user-1', platform: 'x' },
    { id: 't-2', userId: 'user-2', platform: 'reddit' },
  ]);
  store.register<DraftRow>(drafts, []);
});

describe('draftReplyTool', () => {
  it('inserts a pending reply draft against the caller-owned thread', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'huge. what channel finally clicked?',
        confidence: 0.72,
        whyItWorks: 'specific question, short',
      },
      ctx,
    );

    expect(result.draftId).toMatch(/[0-9a-f-]{36}/);
    expect(result.threadId).toBe('t-1');
    expect(result.platform).toBe('x');

    const rows = store.get<DraftRow>(drafts);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe('user-1');
    expect(row.status).toBe('pending');
    expect(row.draftType).toBe('reply');
    expect(row.replyBody).toBe('huge. what channel finally clicked?');
    expect(row.confidenceScore).toBe(0.72);
    expect(row.whyItWorks).toBe('specific question, short');
  });

  it('rejects replies against a thread owned by another user', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(
      draftReplyTool.execute(
        {
          threadId: 't-2', // owned by user-2
          draftBody: 'not mine',
          confidence: 0.5,
        },
        ctx,
      ),
    ).rejects.toThrow(/not found for user/);
    expect(store.get<DraftRow>(drafts)).toHaveLength(0);
  });

  it('rejects an invalid input via the schema', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { threadId: 't-1', draftBody: '', confidence: 0.5 } as any;
    const parse = draftReplyTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('rejects a draft body over the 40k ceiling', () => {
    const hugeBody = 'x'.repeat(40_001);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = {
      threadId: 't-1',
      draftBody: hugeBody,
      confidence: 0.5,
    } as any;
    const parse = draftReplyTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('rejects an out-of-range confidence', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = {
      threadId: 't-1',
      draftBody: 'ok',
      confidence: 1.5,
    } as any;
    const parse = draftReplyTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('leaves whyItWorks null when omitted', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'short',
        confidence: 0.6,
      },
      ctx,
    );
    expect(store.get<DraftRow>(drafts)[0]!.whyItWorks).toBeNull();
  });
});
