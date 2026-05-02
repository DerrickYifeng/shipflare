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
vi.mock('@/lib/queue', () => ({
  enqueueReview: vi.fn(async () => undefined),
}));

import { draftReplyTool } from '../DraftReplyTool';
import { drafts, threads } from '@/lib/db/schema';
import { enqueueReview } from '@/lib/queue';

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
  vi.clearAllMocks();
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
    const bad: unknown = {
      threadId: 't-1',
      draftBody: hugeBody,
      confidence: 0.5,
    };
    const parse = draftReplyTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('rejects an out-of-range confidence', () => {
    const bad: unknown = {
      threadId: 't-1',
      draftBody: 'ok',
      confidence: 1.5,
    };
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

  it('updates the existing pending draft instead of inserting a duplicate on the same thread', async () => {
    // Two content-manager invocations against the same thread used to
    // produce two pending drafts joined to the same threads row, which
    // surfaced as a duplicate tweet card in /today. The tool is now
    // idempotent on (userId, threadId, status='pending'): the second call
    // updates the existing row in place, returns the same draftId, and the
    // store ends up with exactly one row carrying the second call's body.
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const first = await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'first take',
        confidence: 0.6,
        whyItWorks: 'first reasoning',
      },
      ctx,
    );
    expect(store.get<DraftRow>(drafts)).toHaveLength(1);

    const second = await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'second take, sharper',
        confidence: 0.78,
        whyItWorks: 'tightened',
      },
      ctx,
    );

    // Same draftId — the second call updated the first row in place.
    expect(second.draftId).toBe(first.draftId);

    // Exactly one row with the second call's body and confidence.
    const rows = store.get<DraftRow>(drafts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.replyBody).toBe('second take, sharper');
    expect(rows[0]!.confidenceScore).toBe(0.78);
    expect(rows[0]!.whyItWorks).toBe('tightened');
  });

  it('does NOT update a non-pending draft — terminal drafts on the same thread are immutable', async () => {
    // If the existing draft is `posted` / `skipped` / `approved`, treat
    // the new call as a fresh draft (insert a new pending row). The
    // idempotency check is scoped to status='pending' only.
    store.register<DraftRow>(drafts, [
      {
        id: 'd-old-posted',
        userId: 'user-1',
        threadId: 't-1',
        status: 'posted',
        draftType: 'reply',
        replyBody: 'shipped already',
        confidenceScore: 0.9,
        whyItWorks: null,
        engagementDepth: 0,
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const result = await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'a fresh draft for the same thread',
        confidence: 0.7,
      },
      ctx,
    );

    expect(result.draftId).not.toBe('d-old-posted');
    const rows = store.get<DraftRow>(drafts);
    expect(rows).toHaveLength(2);
    const posted = rows.find((r) => r.id === 'd-old-posted')!;
    const fresh = rows.find((r) => r.status === 'pending')!;
    expect(posted.replyBody).toBe('shipped already');
    expect(fresh.replyBody).toBe('a fresh draft for the same thread');
  });
});

describe('draft_reply enqueueReview wire-up', () => {
  it('enqueues a review job after a fresh insert', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const result = await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'a real first-person reply with concrete anchor.',
        confidence: 0.8,
      },
      ctx,
    );

    expect(enqueueReview).toHaveBeenCalledTimes(1);
    expect(enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        productId: 'prod-1',
        draftId: result.draftId,
      }),
    );
    // Regression guard: when no traceId is in ctx, the tool must NOT
    // pass `traceId: ''` (or any other falsy non-undefined value) — the
    // review job schema treats traceId as `.min(1).optional()` and
    // `withEnvelope` mints a UUID only when the field is undefined.
    // Passing an empty string would throw a Zod `too_small` error.
    const callArg = (enqueueReview as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('traceId');
  });

  it('enqueues review on the idempotent update path too', async () => {
    store.register<DraftRow>(drafts, [
      {
        id: 'existing-draft',
        userId: 'user-1',
        threadId: 't-1',
        status: 'pending',
        draftType: 'reply',
        replyBody: 'old body',
        confidenceScore: 0.5,
        whyItWorks: null,
        engagementDepth: 0,
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'updated body still needs review',
        confidence: 0.75,
      },
      ctx,
    );

    expect(enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        productId: 'prod-1',
        draftId: 'existing-draft',
      }),
    );
    // Same regression guard on the idempotent update path.
    const callArg = (enqueueReview as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('traceId');
  });

  it('forwards traceId to enqueueReview when one is in the tool context', async () => {
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      traceId: 'trace-xyz',
    });

    await draftReplyTool.execute(
      {
        threadId: 't-1',
        draftBody: 'reply with trace context',
        confidence: 0.8,
      },
      ctx,
    );

    expect(enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        productId: 'prod-1',
        traceId: 'trace-xyz',
      }),
    );
  });
});
