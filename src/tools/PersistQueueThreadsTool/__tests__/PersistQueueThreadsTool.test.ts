import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture insert/update calls; the impl uses Drizzle's chainable builders.
const insertChain = vi.fn();
const updateChain = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    insert: (...args: unknown[]) => insertChain(...args),
    update: (...args: unknown[]) => updateChain(...args),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    sql: Object.assign(
      (..._args: unknown[]) => ({ __sql: true }),
      { raw: () => ({ __sqlRaw: true }) },
    ),
    eq: () => ({ __eq: true }),
    and: () => ({ __and: true }),
  };
});

import { persistQueueThreadsTool } from '../PersistQueueThreadsTool';

function makeCtx(deps: Record<string, unknown>): {
  abortSignal: AbortSignal;
  emitProgress?: (toolName: string, message: string, metadata?: Record<string, unknown>) => void;
  get<V>(key: string): V;
} {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

function makeTweet(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    external_id: 't1',
    url: 'https://x.com/a/status/1',
    author_username: 'alice',
    author_bio: 'indie dev',
    author_followers: 500,
    body: 'building',
    posted_at: '2026-04-26T00:00:00.000Z',
    likes_count: 10,
    reposts_count: 2,
    replies_count: 1,
    views_count: 1000,
    is_repost: false,
    original_url: null,
    original_author_username: null,
    surfaced_via: null,
    confidence: 0.8,
    reason: 'asking for marketing tools',
    ...overrides,
  };
}

describe('persist_queue_threads tool', () => {
  beforeEach(() => {
    insertChain.mockReset();
    updateChain.mockReset();
  });

  it('persists empty array as no-op without DB call', async () => {
    const result = await persistQueueThreadsTool.execute(
      { threads: [] },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );
    expect(result).toEqual({ inserted: 0, deduped: 0 });
    expect(insertChain).not.toHaveBeenCalled();
  });

  it('inserts rows in engagement-weighted order (highest first)', async () => {
    const valuesCapture = vi.fn();
    insertChain.mockReturnValue({
      values: (rows: unknown) => {
        valuesCapture(rows);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(rows as { externalId: string }[]),
          }),
        };
      },
    });

    await persistQueueThreadsTool.execute(
      {
        threads: [
          makeTweet({ external_id: 'low', confidence: 0.5, likes_count: 1, reposts_count: 0 }),
          makeTweet({ external_id: 'high', confidence: 0.9, likes_count: 200, reposts_count: 30 }),
          makeTweet({ external_id: 'med', confidence: 0.7, likes_count: 20, reposts_count: 3 }),
        ],
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(valuesCapture).toHaveBeenCalledTimes(1);
    const rows = valuesCapture.mock.calls[0]![0] as Array<{ externalId: string }>;
    expect(rows.map((r) => r.externalId)).toEqual(['high', 'med', 'low']);
  });

  it('reports inserted vs deduped counts based on returning() length', async () => {
    insertChain.mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([{ externalId: 'a' }]), // only 'a' was new
        }),
      }),
    });

    const result = await persistQueueThreadsTool.execute(
      {
        threads: [
          makeTweet({ external_id: 'a' }),
          makeTweet({ external_id: 'b' }),
          makeTweet({ external_id: 'c' }),
        ],
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.inserted).toBe(1);
    expect(result.deduped).toBe(2);
  });

  it('merges surfaced_via for repost rows that already existed', async () => {
    const updateValuesCapture = vi.fn();
    insertChain.mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]), // 0 inserted = all dedup'd
        }),
      }),
    });
    updateChain.mockReturnValue({
      set: (s: unknown) => {
        updateValuesCapture(s);
        return { where: () => Promise.resolve() };
      },
    });

    await persistQueueThreadsTool.execute(
      {
        threads: [
          makeTweet({
            external_id: 'shared-tweet',
            is_repost: true,
            surfaced_via: ['@new_reposter'],
          }),
        ],
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(updateChain).toHaveBeenCalledTimes(1);
    expect(updateValuesCapture).toHaveBeenCalledTimes(1);
    const setArg = updateValuesCapture.mock.calls[0]![0] as Record<string, unknown>;
    // The set should reference surfacedVia and use a JSONB merge expression.
    expect(setArg).toHaveProperty('surfacedVia');
  });

  it('persists authorBio + authorFollowers onto the threads row', async () => {
    const valuesCapture = vi.fn();
    insertChain.mockReturnValue({
      values: (rows: unknown) => {
        valuesCapture(rows);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ externalId: 't1' }]),
          }),
        };
      },
    });

    await persistQueueThreadsTool.execute(
      {
        threads: [
          makeTweet({
            author_bio: 'building shipflare — indie hacker',
            author_followers: 1234,
          }),
        ],
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(valuesCapture).toHaveBeenCalledTimes(1);
    const rows = valuesCapture.mock.calls[0]![0] as Array<{
      authorBio: string | null;
      authorFollowers: number | null;
    }>;
    expect(rows[0]!.authorBio).toBe('building shipflare — indie hacker');
    expect(rows[0]!.authorFollowers).toBe(1234);
  });

  it('persists null authorBio + authorFollowers when xAI returned them as null', async () => {
    const valuesCapture = vi.fn();
    insertChain.mockReturnValue({
      values: (rows: unknown) => {
        valuesCapture(rows);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ externalId: 't1' }]),
          }),
        };
      },
    });

    await persistQueueThreadsTool.execute(
      {
        threads: [makeTweet({ author_bio: null, author_followers: null })],
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    const rows = valuesCapture.mock.calls[0]![0] as Array<{
      authorBio: string | null;
      authorFollowers: number | null;
    }>;
    expect(rows[0]!.authorBio).toBeNull();
    expect(rows[0]!.authorFollowers).toBeNull();
  });

  it('persists canMentionProduct + mentionSignal onto the threads row', async () => {
    const valuesCapture = vi.fn();
    insertChain.mockReturnValue({
      values: (rows: unknown) => {
        valuesCapture(rows);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ externalId: 't1' }]),
          }),
        };
      },
    });

    await persistQueueThreadsTool.execute(
      {
        threads: [
          makeTweet({
            can_mention_product: true,
            mention_signal: 'tool_question',
          }),
        ],
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(valuesCapture).toHaveBeenCalledTimes(1);
    const rows = valuesCapture.mock.calls[0]![0] as Array<{
      canMentionProduct: boolean;
      mentionSignal: string;
    }>;
    expect(rows[0]!.canMentionProduct).toBe(true);
    expect(rows[0]!.mentionSignal).toBe('tool_question');
  });

  it('defaults canMentionProduct=false + mentionSignal="no_fit" when omitted', async () => {
    const valuesCapture = vi.fn();
    insertChain.mockReturnValue({
      values: (rows: unknown) => {
        valuesCapture(rows);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ externalId: 't1' }]),
          }),
        };
      },
    });

    await persistQueueThreadsTool.execute(
      { threads: [makeTweet()] },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    const rows = valuesCapture.mock.calls[0]![0] as Array<{
      canMentionProduct: boolean;
      mentionSignal: string;
    }>;
    expect(rows[0]!.canMentionProduct).toBe(false);
    expect(rows[0]!.mentionSignal).toBe('no_fit');
  });

  it('writes quotedText / inReplyToText cols when present on the candidate', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve([]),
      }),
    });
    insertChain.mockReturnValue({ values: valuesMock });

    const tweet = makeTweet({
      external_id: 't-quote',
      quoted_text: 'OMG this actually worked',
      quoted_author: 'anumness',
      in_reply_to_text: null,
      in_reply_to_author: null,
    });

    await persistQueueThreadsTool.execute(
      { threads: [tweet] },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(valuesMock).toHaveBeenCalledTimes(1);
    const rows = valuesMock.mock.calls[0]![0] as Array<{
      quotedText?: string | null;
      quotedAuthor?: string | null;
      inReplyToText?: string | null;
      inReplyToAuthor?: string | null;
    }>;
    expect(rows[0]!.quotedText).toBe('OMG this actually worked');
    expect(rows[0]!.quotedAuthor).toBe('anumness');
    expect(rows[0]!.inReplyToText).toBeNull();
    expect(rows[0]!.inReplyToAuthor).toBeNull();
  });

  it('writes nulls when conversation fields are absent on the candidate', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve([]),
      }),
    });
    insertChain.mockReturnValue({ values: valuesMock });

    const tweet = makeTweet({ external_id: 't-plain' });

    await persistQueueThreadsTool.execute(
      { threads: [tweet] },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    const rows = valuesMock.mock.calls[0]![0] as Array<{
      quotedText?: string | null;
      inReplyToText?: string | null;
    }>;
    expect(rows[0]!.quotedText ?? null).toBeNull();
    expect(rows[0]!.inReplyToText ?? null).toBeNull();
  });

  it('emits tool_progress before persistence', async () => {
    insertChain.mockReturnValue({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([{ externalId: 't1' }]),
        }),
      }),
    });

    const emit = vi.fn();
    const ctx = makeCtx({ userId: 'u1', productId: 'p1' });
    ctx.emitProgress = emit;

    await persistQueueThreadsTool.execute(
      { threads: [makeTweet()] },
      ctx,
    );

    expect(emit).toHaveBeenCalled();
    expect(emit.mock.calls[0]).toEqual([
      'persist_queue_threads',
      expect.stringMatching(/Persisting 1 thread/),
      expect.any(Object),
    ]);
  });
});
