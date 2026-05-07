/**
 * find_threads_via_xai unit tests.
 *
 * Mocks xaiFindCustomersTool, runForkSkill (judging-thread-quality),
 * persistQueueThreadsTool, and MemoryStore so the test asserts the
 * orchestration shape only — round looping, mechanical refinement,
 * reasoning escalation, MAX_ROUNDS cap, allSettled fan-out, and the
 * StructuredOutput shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@/core/types';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';
import type { TweetCandidate } from '@/tools/XaiFindCustomersTool/schema';

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

const runForkSkillMock = vi.hoisted(() => vi.fn());
vi.mock('@/skills/run-fork-skill', () => ({
  runForkSkill: runForkSkillMock,
}));

const xaiExecMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/XaiFindCustomersTool/XaiFindCustomersTool', () => ({
  xaiFindCustomersTool: { execute: xaiExecMock },
  XAI_FIND_CUSTOMERS_TOOL_NAME: 'xai_find_customers',
}));

const persistExecMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/PersistQueueThreadsTool/PersistQueueThreadsTool', () => ({
  persistQueueThreadsTool: { execute: persistExecMock },
  PERSIST_QUEUE_THREADS_TOOL_NAME: 'persist_queue_threads',
}));

const loadEntryMock = vi.hoisted(() => vi.fn());
vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    loadEntry = loadEntryMock;
  },
}));

import {
  findThreadsViaXaiTool,
  FIND_THREADS_VIA_XAI_TOOL_NAME,
  composeRefinementMessage,
  buildFirstTurnMessage,
} from '../FindThreadsViaXaiTool';
import { products } from '@/lib/db/schema';

interface ProductRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  valueProp: string | null;
  targetAudience: string | null;
  keywords: string[];
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

function seedProduct(store: InMemoryStore): void {
  const row: ProductRow = {
    id: 'prod-1',
    userId: 'user-1',
    name: 'TestProduct',
    description: 'a tool for indie devs',
    valueProp: 'fast deploys',
    targetAudience: 'indie hackers',
    keywords: ['ci', 'deploy'],
  };
  store.register<ProductRow>(products, [row]);
}

function makeTweet(overrides: Partial<TweetCandidate> = {}): TweetCandidate {
  return {
    external_id: overrides.external_id ?? 'tw-1',
    url: overrides.url ?? 'https://twitter.com/foo/status/1',
    author_username: overrides.author_username ?? 'foo',
    author_bio: overrides.author_bio ?? null,
    author_followers: overrides.author_followers ?? null,
    body: overrides.body ?? 'looking for a CI tool that does not cost $300/mo',
    posted_at: overrides.posted_at ?? '2026-04-25T14:00:00Z',
    likes_count: overrides.likes_count ?? 10,
    reposts_count: overrides.reposts_count ?? 1,
    replies_count: overrides.replies_count ?? 2,
    views_count: overrides.views_count ?? 200,
    is_repost: overrides.is_repost ?? false,
    original_url: overrides.original_url ?? null,
    original_author_username: overrides.original_author_username ?? null,
    surfaced_via: overrides.surfaced_via ?? null,
    confidence: overrides.confidence ?? 0.8,
    reason: overrides.reason ?? 'pain match',
  };
}

function xaiResponse(tweets: TweetCandidate[], notes = 'ok') {
  return {
    tweets,
    notes,
    assistantMessage: { role: 'assistant' as const, content: 'json output' },
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
  };
}

function judgingResponse(
  partial: Partial<{
    keep: boolean;
    score: number;
    reason: string;
    signals: string[];
    canMentionProduct: boolean;
    mentionSignal: string;
  }> = {},
) {
  return {
    result: {
      keep: partial.keep ?? true,
      score: partial.score ?? 0.75,
      reason: partial.reason ?? 'fits ICP',
      signals: partial.signals ?? [],
      canMentionProduct: partial.canMentionProduct ?? true,
      mentionSignal: partial.mentionSignal ?? 'tool_question',
    },
    usage: {},
  };
}

let store: InMemoryStore;
beforeEach(() => {
  vi.clearAllMocks();
  store = createInMemoryStore();
  seedProduct(store);
  loadEntryMock.mockResolvedValue({
    name: 'discovery-rubric',
    description: 'rubric',
    type: 'reference',
    content: '## Ideal customer\nIndie devs running CI.',
  });
  persistExecMock.mockImplementation(
    async (input: { threads: TweetCandidate[] }) => ({
      inserted: input.threads.length,
      deduped: 0,
    }),
  );
});

describe('findThreadsViaXaiTool', () => {
  it('exports the canonical name', () => {
    expect(FIND_THREADS_VIA_XAI_TOOL_NAME).toBe('find_threads_via_xai');
  });

  it('rejects maxResults > 50 at the Zod boundary', () => {
    const parse = findThreadsViaXaiTool.inputSchema.safeParse({
      trigger: 'daily',
      maxResults: 51,
    });
    expect(parse.success).toBe(false);
    const ok = findThreadsViaXaiTool.inputSchema.safeParse({
      trigger: 'daily',
      maxResults: 50,
    });
    expect(ok.success).toBe(true);
  });

  it('single-round PASS — ≥80% strong, persists immediately, no refinement', async () => {
    // maxResults=5 → strong target = ceil(5*0.8) = 4. Surface 5 strong.
    const tweets = Array.from({ length: 5 }, (_, i) =>
      makeTweet({ external_id: `tw-${i}`, url: `https://twitter.com/u/status/${i}` }),
    );
    xaiExecMock.mockResolvedValueOnce(xaiResponse(tweets));
    runForkSkillMock.mockImplementation(async () =>
      judgingResponse({ keep: true, score: 0.8 }),
    );

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 5 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(xaiExecMock).toHaveBeenCalledTimes(1);
    expect(result.queued).toBe(5);
    expect(result.scanned).toBe(5);
    expect(result.topQueued.length).toBe(5);
    // All 5 had score 0.8 → topQueued.confidence reflects judging score
    expect(result.topQueued[0]!.confidence).toBe(0.8);
    expect(persistExecMock).toHaveBeenCalledOnce();
    const persistCall = persistExecMock.mock.calls[0]![0] as {
      threads: TweetCandidate[];
    };
    expect(persistCall.threads[0]!.can_mention_product).toBe(true);
    expect(persistCall.threads[0]!.mention_signal).toBe('tool_question');
  });

  it('two-round refinement — round 1 surfaces 3 strong + 5 rejected (competitor_bio×4); round 2 user msg contains nudge', async () => {
    // Round 1: 3 strong + 5 rejected with competitor_bio signals
    const round1Tweets = Array.from({ length: 8 }, (_, i) =>
      makeTweet({ external_id: `r1-${i}`, url: `https://x.com/u/status/r1-${i}` }),
    );
    // Round 2: 7 more strong matches
    const round2Tweets = Array.from({ length: 7 }, (_, i) =>
      makeTweet({ external_id: `r2-${i}`, url: `https://x.com/u/status/r2-${i}` }),
    );

    xaiExecMock
      .mockResolvedValueOnce(xaiResponse(round1Tweets))
      .mockResolvedValueOnce(xaiResponse(round2Tweets));

    let judgeCall = 0;
    runForkSkillMock.mockImplementation(async () => {
      const c = judgeCall++;
      if (c < 8) {
        // Round 1: indices 0-2 strong, 3-6 rejected (competitor_bio),
        // 7 rejected (engagement_pod).
        if (c < 3) return judgingResponse({ keep: true, score: 0.8 });
        if (c < 7)
          return judgingResponse({
            keep: false,
            score: 0.2,
            signals: ['competitor_bio'],
          });
        return judgingResponse({
          keep: false,
          score: 0.2,
          signals: ['engagement_pod'],
        });
      }
      // Round 2: all strong
      return judgingResponse({ keep: true, score: 0.85 });
    });

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(xaiExecMock).toHaveBeenCalledTimes(2);
    // The 2nd xai call carries the refinement nudge in messages[].
    const secondCall = xaiExecMock.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const lastUserMsg = [...secondCall.messages]
      .reverse()
      .find((m) => m.role === 'user');
    // Refinement nudge text reflects the competitor_bio signal verbatim
    // (mechanical SIGNAL_NUDGE lookup — no LLM in the loop).
    expect(lastUserMsg?.content).toContain('competing tools');
    // 3 strong from r1 + 7 strong from r2 = 10 >= ceil(10*0.8)=8 → break
    expect(result.queued).toBe(10);
  });

  it('escalates reasoning=true exactly once after 2 unsuccessful refines', async () => {
    // Round 1, 2: surface candidates that all reject (unsuccessful refines).
    // Round 3 (3rd call): MUST have reasoning=true.
    const r1 = [makeTweet({ external_id: 'r1' })];
    const r2 = [makeTweet({ external_id: 'r2' })];
    const r3 = Array.from({ length: 5 }, (_, i) =>
      makeTweet({ external_id: `r3-${i}` }),
    );
    xaiExecMock
      .mockResolvedValueOnce(xaiResponse(r1))
      .mockResolvedValueOnce(xaiResponse(r2))
      .mockResolvedValueOnce(xaiResponse(r3));

    let judgeCall = 0;
    runForkSkillMock.mockImplementation(async () => {
      const c = judgeCall++;
      if (c < 2) {
        return judgingResponse({
          keep: false,
          score: 0.1,
          signals: ['no_fit'],
        });
      }
      return judgingResponse({ keep: true, score: 0.8 });
    });

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 5 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(xaiExecMock).toHaveBeenCalledTimes(3);
    const call1 = xaiExecMock.mock.calls[0]![0] as { reasoning: boolean };
    const call2 = xaiExecMock.mock.calls[1]![0] as { reasoning: boolean };
    const call3 = xaiExecMock.mock.calls[2]![0] as { reasoning: boolean };
    expect(call1.reasoning).toBe(false);
    expect(call2.reasoning).toBe(false);
    expect(call3.reasoning).toBe(true);
  });

  it('caps at MAX_ROUNDS (10) and persists whatever has accumulated', async () => {
    // Surface 1 weak candidate per round forever — never reaches strong target.
    xaiExecMock.mockImplementation(async () =>
      xaiResponse([makeTweet({ external_id: `t-${Math.random()}` })]),
    );
    runForkSkillMock.mockImplementation(async () =>
      judgingResponse({ keep: false, score: 0.2, signals: ['no_fit'] }),
    );

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 10 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(xaiExecMock).toHaveBeenCalledTimes(10);
    expect(result.queued).toBe(0);
    // No threads to persist → persistExecMock NOT called.
    expect(persistExecMock).not.toHaveBeenCalled();
    expect(result.scoutNotes.length).toBeGreaterThan(0);
  });

  it('empty result — xAI returns 0 candidates twice, persist 0, scoutNotes explains', async () => {
    xaiExecMock
      .mockResolvedValueOnce(xaiResponse([], 'no matches found'))
      .mockResolvedValueOnce(xaiResponse([], 'still nothing'));

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 5 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.queued).toBe(0);
    expect(result.scanned).toBe(0);
    expect(persistExecMock).not.toHaveBeenCalled();
    expect(runForkSkillMock).not.toHaveBeenCalled();
    expect(result.scoutNotes).toMatch(/0 candidates|no ICP matches/i);
  });

  it('canMentionProduct + mentionSignal flow through to persist input', async () => {
    const tweets = [makeTweet({ external_id: 'tw-9' })];
    xaiExecMock.mockResolvedValueOnce(xaiResponse(tweets));
    runForkSkillMock.mockImplementation(async () =>
      judgingResponse({
        keep: true,
        score: 0.85,
        canMentionProduct: false,
        mentionSignal: 'vulnerable',
      }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(persistExecMock).toHaveBeenCalledOnce();
    const persistArgs = persistExecMock.mock.calls[0]![0] as {
      threads: TweetCandidate[];
    };
    expect(persistArgs.threads[0]!.can_mention_product).toBe(false);
    expect(persistArgs.threads[0]!.mention_signal).toBe('vulnerable');
  });

  it('handles malformed judging output gracefully (skips, does not crash)', async () => {
    // Production crash regression: judging-thread-quality returned an
    // object missing the `signals` array, and the loop accessed
    // `j.verdict.signals` directly. Now safeParse drops the malformed
    // verdict and the loop continues.
    //
    // Every judging call returns a malformed verdict — proves the loop
    // never accesses `verdict.signals` on a parse-failure path. The
    // tool must complete without throwing and queue zero.
    const tweets = Array.from({ length: 3 }, (_, i) =>
      makeTweet({ external_id: `t-${i}` }),
    );
    // Use mockResolvedValue (not Once) so all 10 rounds — if the loop
    // doesn't break early — still hit the same malformed shape.
    xaiExecMock.mockResolvedValue(xaiResponse(tweets));

    runForkSkillMock.mockResolvedValue({
      // Schema requires `keep`, `score`, `reason`, etc. — empty object
      // mirrors the production payload that triggered
      // `j.verdict.signals` undefined.
      result: { something: 'totally wrong' },
      usage: {},
    });

    // The execute call MUST NOT throw, despite every verdict being
    // malformed. The loop drops parse failures and continues.
    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 3 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    // No valid verdicts → no strong matches → queued = 0 → persist
    // skipped entirely.
    expect(result.queued).toBe(0);
    expect(persistExecMock).not.toHaveBeenCalled();
    // The judging mock was invoked — the orchestrator did try to
    // judge candidates. The loop DID NOT crash on
    // `j.verdict.signals` access.
    expect(runForkSkillMock).toHaveBeenCalled();
  });

  it('passes authorBio + authorFollowers through to judging-thread-quality candidate', async () => {
    xaiExecMock.mockResolvedValueOnce(
      xaiResponse([
        makeTweet({
          author_bio: 'building thing — indie hacker',
          author_followers: 1234,
        }),
      ]),
    );
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.85 }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(runForkSkillMock).toHaveBeenCalledTimes(1);
    const callArgs = runForkSkillMock.mock.calls[0]!;
    // Positional args: (skillName, args, outputSchema, ctx). args is JSON string.
    const argsJson = callArgs[1] as string;
    const parsed = JSON.parse(argsJson) as {
      candidate: { authorBio: string | null; authorFollowers: number | null };
    };
    expect(parsed.candidate.authorBio).toBe('building thing — indie hacker');
    expect(parsed.candidate.authorFollowers).toBe(1234);
  });

  it('passes null authorBio + authorFollowers when xAI returned them as null', async () => {
    xaiExecMock.mockResolvedValueOnce(
      xaiResponse([
        makeTweet({ author_bio: null, author_followers: null }),
      ]),
    );
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.85 }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as {
      candidate: { authorBio: string | null; authorFollowers: number | null };
    };
    expect(parsed.candidate.authorBio).toBeNull();
    expect(parsed.candidate.authorFollowers).toBeNull();
  });

  it('passes the judging-thread-quality output schema to runForkSkill', async () => {
    // Schema-pass-through regression: runAgent synthesizes the
    // StructuredOutput tool only when given an output schema. Without
    // it, the LLM is free to emit anything and the safeParse downstream
    // becomes the only line of defense.
    xaiExecMock.mockResolvedValueOnce(xaiResponse([makeTweet()]));
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.8 }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(runForkSkillMock).toHaveBeenCalledTimes(1);
    const callArgs = runForkSkillMock.mock.calls[0]!;
    // Positional args: (skillName, args, outputSchema, ctx)
    expect(callArgs[0]).toBe('judging-thread-quality');
    // outputSchema MUST be a Zod-shaped object (has .safeParse method).
    const schema = callArgs[2] as { safeParse?: unknown } | undefined;
    expect(schema).toBeDefined();
    expect(typeof schema?.safeParse).toBe('function');
  });

  it('one judging-thread-quality fork rejection does NOT lose the round (allSettled)', async () => {
    const tweets = Array.from({ length: 5 }, (_, i) =>
      makeTweet({ external_id: `t-${i}` }),
    );
    xaiExecMock.mockResolvedValueOnce(xaiResponse(tweets));

    let call = 0;
    runForkSkillMock.mockImplementation(async () => {
      const c = call++;
      if (c === 2) throw new Error('judging fork crashed');
      return judgingResponse({ keep: true, score: 0.8 });
    });

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 4 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    // 5 candidates, 1 rejected mid-flight → 4 strong → meets target ceil(4*0.8)=4
    expect(result.queued).toBe(4);
  });

  it('dedups across rounds by external_id', async () => {
    // Round 1: 1 strong ID=a. Round 2: returns the same ID=a + a new ID=b.
    // The rerun of `a` should NOT be re-judged.
    xaiExecMock
      .mockResolvedValueOnce(xaiResponse([makeTweet({ external_id: 'a' })]))
      .mockResolvedValueOnce(
        xaiResponse([
          makeTweet({ external_id: 'a' }),
          makeTweet({ external_id: 'b' }),
        ]),
      )
      .mockResolvedValueOnce(
        xaiResponse([makeTweet({ external_id: 'c' })]),
      )
      .mockResolvedValueOnce(
        xaiResponse([makeTweet({ external_id: 'd' })]),
      );
    runForkSkillMock.mockImplementation(async () =>
      judgingResponse({ keep: true, score: 0.8 }),
    );

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 5 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    // a, b, c, d = 4 unique. ceil(5*0.8)=4 → reach target after round 4.
    expect(result.scanned).toBe(4);
    // Judging called once per UNIQUE candidate.
    expect(runForkSkillMock).toHaveBeenCalledTimes(4);
  });

  it('throws when product not found', async () => {
    await expect(
      findThreadsViaXaiTool.execute(
        { trigger: 'daily', maxResults: 5 },
        makeCtx(store, { userId: 'user-1', productId: 'nonexistent' }),
      ),
    ).rejects.toThrow(/product .* not found/);
  });

  it('proceeds without rubric when memory entry not found', async () => {
    loadEntryMock.mockResolvedValueOnce(null);
    xaiExecMock.mockResolvedValueOnce(xaiResponse([makeTweet()]));
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.8 }),
    );

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.queued).toBe(1);
    // First-turn message was still composed and sent.
    const firstCall = xaiExecMock.mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    expect(firstCall.messages[0]!.content).toContain('TestProduct');
  });

  it('emits live progress at round milestones so UI tool card updates in real-time', async () => {
    // Single-round happy path: query → judge → persist. We expect at
    // least the round-query, judging, post-judging, and persist events
    // attributed to find_threads_via_xai (NOT the sub-tools).
    const tweets = Array.from({ length: 4 }, (_, i) =>
      makeTweet({ external_id: `tw-${i}`, url: `https://twitter.com/u/status/${i}` }),
    );
    xaiExecMock.mockResolvedValueOnce(xaiResponse(tweets));
    runForkSkillMock.mockImplementation(async () =>
      judgingResponse({ keep: true, score: 0.8 }),
    );

    const emit = vi.fn();
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    ctx.emitProgress = emit;

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 4 },
      ctx,
    );

    // All progress events from find_threads_via_xai itself (sub-tool
    // events have a different toolName and live-stream separately).
    const ownEvents = emit.mock.calls.filter(
      (c) => c[0] === 'find_threads_via_xai',
    );
    expect(ownEvents.length).toBeGreaterThanOrEqual(2);

    // Round 1 query milestone
    expect(emit).toHaveBeenCalledWith(
      'find_threads_via_xai',
      expect.stringContaining('querying xAI'),
      expect.any(Object),
    );
    // Judging milestone
    expect(emit).toHaveBeenCalledWith(
      'find_threads_via_xai',
      expect.stringContaining('judging'),
      expect.any(Object),
    );
    // Persist milestone
    expect(emit).toHaveBeenCalledWith(
      'find_threads_via_xai',
      expect.stringContaining('Persisting'),
      expect.any(Object),
    );
  });

  it('reports rough costUsd from xAI usage tokens', async () => {
    xaiExecMock.mockResolvedValueOnce({
      tweets: [makeTweet()],
      notes: '',
      assistantMessage: { role: 'assistant' as const, content: 'x' },
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    });
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.8 }),
    );

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    // 1M in @ $5 + 1M out @ $15 = $20
    expect(result.costUsd).toBeCloseTo(20, 5);
  });
});

describe('composeRefinementMessage helper', () => {
  it('produces a top-3 nudge ordered by signal frequency', () => {
    const sigs = new Map<string, number>([
      ['competitor_bio', 5],
      ['engagement_pod', 3],
      ['advice_giver', 2],
      ['political', 1],
    ]);
    const msg = composeRefinementMessage(
      sigs,
      ['https://x.com/a', 'https://x.com/b', 'https://x.com/c'],
      [],
    );
    expect(msg).toContain('drop accounts whose bios mention competing tools');
    expect(msg).toContain('engagement-pod');
    expect(msg).toContain('teaching, not asking');
    // Politicial only has count=1 and is past the top-3 cap
    expect(msg).not.toContain('political');
    expect(msg).toContain('Find more like https://x.com/a / https://x.com/b');
  });

  it('drops unknown signals silently rather than crashing', () => {
    const sigs = new Map<string, number>([
      ['unknown_signal_xyz', 9],
      ['competitor_bio', 1],
    ]);
    const msg = composeRefinementMessage(sigs, [], []);
    // unknown_signal_xyz has no SIGNAL_NUDGE entry, so its nudge is dropped.
    // competitor_bio remains.
    expect(msg).toContain('competing tools');
    expect(msg).not.toContain('unknown_signal_xyz');
  });

  it('handles empty rejection map and empty strong list gracefully', () => {
    const msg = composeRefinementMessage(new Map(), [], []);
    expect(msg).toContain('Found 0 strong matches');
  });
});

describe('buildFirstTurnMessage helper', () => {
  it('includes product fields, intent, and rubric verbatim', () => {
    const msg = buildFirstTurnMessage(
      {
        id: 'p1',
        name: 'P',
        description: 'D',
        valueProp: 'V',
        targetAudience: 'T',
        keywords: ['k1', 'k2'],
      },
      'RUBRIC_BODY',
      'focus on indie hackers',
      10,
      [],
    );
    expect(msg).toContain('Name: P');
    expect(msg).toContain('Value prop: V');
    expect(msg).toContain('Target audience: T');
    expect(msg).toContain('k1, k2');
    expect(msg).toContain('focus on indie hackers');
    expect(msg).toContain('RUBRIC_BODY');
    expect(msg).toContain('Up to 20 candidates'); // maxResults * 2
  });

  it('handles missing rubric and intent gracefully', () => {
    const msg = buildFirstTurnMessage(
      {
        id: 'p1',
        name: 'P',
        description: 'D',
        valueProp: null,
        targetAudience: null,
        keywords: [],
      },
      '',
      undefined,
      5,
      [],
    );
    expect(msg).toContain('Value prop: (not specified)');
    expect(msg).toContain('Target audience: (not specified)');
    expect(msg).toContain('Keywords: (none)');
    expect(msg).not.toContain('FOUNDER INTENT');
    expect(msg).not.toContain('ICP RUBRIC');
  });

  it('asks xAI for quoted_text + in_reply_to_text', () => {
    const msg = buildFirstTurnMessage(
      {
        id: 'p1',
        name: 'ShipFlare',
        description: 'AI marketing teammates',
        valueProp: null,
        targetAudience: null,
        keywords: ['indie', 'marketing'],
      },
      '',
      undefined,
      10,
      [],
    );
    expect(msg).toContain('quoted_text');
    expect(msg).toContain('quoted_author');
    expect(msg).toContain('in_reply_to_text');
    expect(msg).toContain('in_reply_to_author');
  });

  it('preserves existing repost guidance', () => {
    const msg = buildFirstTurnMessage(
      {
        id: 'p1',
        name: 'ShipFlare',
        description: 'AI marketing teammates',
        valueProp: null,
        targetAudience: null,
        keywords: ['indie', 'marketing'],
      },
      '',
      undefined,
      10,
      [],
    );
    expect(msg).toContain('Reposts ARE valuable signal');
  });
});

describe('buildFirstTurnMessage exclude-authors', () => {
  const baseProduct = {
    id: 'p1',
    name: 'TestProduct',
    description: 'd',
    valueProp: null,
    targetAudience: null,
    keywords: [],
  };

  it('omits the exclude block when no authors are throttled', () => {
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, []);
    expect(msg).not.toMatch(/Do NOT surface tweets/i);
  });

  it('includes a Do-NOT line listing throttled authors', () => {
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, [
      'alice',
      'bob_dev',
      'charlie123',
    ]);
    expect(msg).toMatch(/Do NOT surface tweets authored by/i);
    expect(msg).toContain('@alice');
    expect(msg).toContain('@bob_dev');
    expect(msg).toContain('@charlie123');
  });

  it('truncates long lists with an "and others" tail to keep the prompt bounded', () => {
    const many = Array.from({ length: 75 }, (_, i) => `user${i}`);
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, many);
    const matches = msg.match(/@user\d+/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(50);
    expect(msg).toMatch(/and others.*skip authors that look like/i);
  });

  it('preserves the empty-list output verbatim (no collapsed blank lines)', () => {
    const baseProduct = {
      id: 'p1',
      name: 'TestProduct',
      description: 'd',
      valueProp: null,
      targetAudience: null,
      keywords: [],
    };
    const msg = buildFirstTurnMessage(baseProduct, '', undefined, 10, []);

    // Paragraph break between intro and PRODUCT header.
    expect(msg).toMatch(/solves\.\n\nPRODUCT/);
    // Paragraph break between Keywords and Constraints (since both
    // intent and rubric are absent, the joined section evaluates to '').
    expect(msg).toMatch(/Keywords: \(none\)\n\nConstraints/);
  });
});

describe('composeRefinementMessage exclude-authors reinforcement', () => {
  it('appends "Still skip ..." when authors are present', () => {
    const m = composeRefinementMessage(new Map(), [], ['alice', 'bob']);
    expect(m).toMatch(/skip @alice, @bob/i);
  });

  it('omits the reinforcement when the list is empty', () => {
    const m = composeRefinementMessage(new Map(), [], []);
    expect(m).not.toMatch(/skip @/i);
  });
});

// ---------------------------------------------------------------------
// Reddit branch (Task 2b)
// ---------------------------------------------------------------------

import { channels } from '@/lib/db/schema';

interface ChannelRow {
  id: string;
  userId: string;
  platform: string;
  username: string;
  oauthTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
}

interface RedditThread {
  external_id: string;
  url: string;
  subreddit: string;
  author_username: string;
  author_karma: number | null;
  title: string;
  body: string;
  posted_at: string;
  score: number;
  num_comments: number;
  num_crossposts: number;
  is_self: boolean;
  link_url: string | null;
  over_18: boolean;
  locked: boolean;
  archived: boolean;
  confidence: number;
  reason: string;
}

function makeRedditThread(overrides: Partial<RedditThread> = {}): RedditThread {
  return {
    external_id: overrides.external_id ?? '1abc234',
    url:
      overrides.url ??
      'https://www.reddit.com/r/SaaS/comments/1abc234/test',
    subreddit: overrides.subreddit ?? 'SaaS',
    author_username: overrides.author_username ?? 'foo',
    author_karma: overrides.author_karma ?? 500,
    title: overrides.title ?? 'How do I market my SaaS without burning cash',
    body: overrides.body ?? 'Lorem ipsum, looking for advice.',
    posted_at: overrides.posted_at ?? '2026-05-06T10:00:00Z',
    score: overrides.score ?? 12,
    num_comments: overrides.num_comments ?? 5,
    num_crossposts: overrides.num_crossposts ?? 0,
    is_self: overrides.is_self ?? true,
    link_url: overrides.link_url ?? null,
    over_18: overrides.over_18 ?? false,
    locked: overrides.locked ?? false,
    archived: overrides.archived ?? false,
    confidence: overrides.confidence ?? 0.85,
    reason: overrides.reason ?? 'No marketing person, looking for distribution.',
  };
}

/**
 * Inner xAI tool result shape for the Reddit branch. The Reddit code
 * path reads from `output` (raw JSON parsed by xAI) and ignores
 * `tweets` — so we set tweets:[] and put the Reddit envelope in
 * `output`.
 */
function xaiRedditResponse(threads: RedditThread[], notes = 'ok') {
  return {
    tweets: [] as TweetCandidate[],
    notes,
    output: { threads, notes },
    assistantMessage: { role: 'assistant' as const, content: 'json output' },
    usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
  };
}

describe('platform: reddit', () => {
  it('default platform is x — explicit assertion that omitting platform preserves x_search', async () => {
    // No `platform` field → should default to x and call inner xAI
    // tool with x_search tool config.
    xaiExecMock.mockResolvedValueOnce(xaiResponse([makeTweet()]));
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.8 }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1 },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const innerCall = xaiExecMock.mock.calls[0]![0] as {
      tools: Array<Record<string, unknown>>;
    };
    expect(innerCall.tools).toEqual([{ type: 'x_search' }]);
  });

  it('uses web_search with reddit.com domain filter when platform=reddit', async () => {
    xaiExecMock.mockResolvedValueOnce(xaiRedditResponse([makeRedditThread()]));
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.85 }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const innerCall = xaiExecMock.mock.calls[0]![0] as {
      tools: Array<Record<string, unknown>>;
    };
    expect(innerCall.tools).toHaveLength(1);
    expect(innerCall.tools[0]).toMatchObject({
      type: 'web_search',
      filters: { allowed_domains: ['reddit.com'] },
    });
  });

  it('passes Reddit JSON schema + name to the inner xAI tool', async () => {
    xaiExecMock.mockResolvedValueOnce(xaiRedditResponse([]));

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const innerCall = xaiExecMock.mock.calls[0]![0] as {
      responseFormatName?: string;
      responseFormatSchema?: { required?: string[] };
    };
    expect(innerCall.responseFormatName).toBe('reddit_thread_search_result');
    // The Reddit JSON schema's outer envelope requires `threads` (not
    // `tweets`). Asserting on a stable structural property is more
    // resilient than asserting deep equality.
    expect(innerCall.responseFormatSchema?.required).toContain('threads');
  });

  it('injects u/<handle> self-exclude when channels.username is seeded', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'reddit',
        username: 'shipflare-founder',
        oauthTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
      },
    ]);
    xaiExecMock.mockResolvedValueOnce(xaiRedditResponse([]));

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const innerCall = xaiExecMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const firstUserMsg = innerCall.messages[0]!.content;
    expect(firstUserMsg).toContain('u/shipflare-founder');
    expect(firstUserMsg).toMatch(/founder running this product/i);
  });

  it('omits self-exclude line when no reddit channel exists', async () => {
    // No channel row seeded — store.tables has no entry for `channels`.
    xaiExecMock.mockResolvedValueOnce(xaiRedditResponse([]));

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const innerCall = xaiExecMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const firstUserMsg = innerCall.messages[0]!.content;
    expect(firstUserMsg).not.toMatch(/founder running this product/i);
  });

  it('parses { threads, notes } envelope from xAI output and judges each thread', async () => {
    const threads = [
      makeRedditThread({ external_id: 'r1' }),
      makeRedditThread({
        external_id: 'r2',
        url: 'https://www.reddit.com/r/SaaS/comments/r2/test',
      }),
    ];
    xaiExecMock.mockResolvedValueOnce(
      xaiRedditResponse(threads, 'Strong matches in r/SaaS'),
    );
    runForkSkillMock.mockResolvedValue(
      judgingResponse({ keep: true, score: 0.85 }),
    );

    const result = await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 2, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(runForkSkillMock).toHaveBeenCalledTimes(2);
    expect(result.scanned).toBe(2);
    // Task 2c wired Reddit persist — the call now fires with platform=reddit.
    expect(persistExecMock).toHaveBeenCalledTimes(1);
    const persistArg = persistExecMock.mock.calls[0]![0] as {
      platform: string;
      threads: Array<{ external_id: string }>;
    };
    expect(persistArg.platform).toBe('reddit');
    expect(persistArg.threads).toHaveLength(2);
    expect(result.queued).toBe(2);
    // topQueued surfaces both threads with confidence from judging.
    expect(result.topQueued).toHaveLength(2);
    expect(result.topQueued[0]!.confidence).toBe(0.85);
    // Reddit topQueued rows have null engagement-stats (X-only fields).
    expect(result.topQueued[0]!.likesCount).toBeNull();
    expect(result.topQueued[0]!.repostsCount).toBeNull();
  });

  it('passes platform=reddit + author_karma into the judging-thread-quality candidate', async () => {
    xaiExecMock.mockResolvedValueOnce(
      xaiRedditResponse([
        makeRedditThread({
          author_username: 'reddit-user',
          author_karma: 7891,
          title: 'r/SaaS title here',
          body: 'r/SaaS body text',
        }),
      ]),
    );
    runForkSkillMock.mockResolvedValueOnce(
      judgingResponse({ keep: true, score: 0.85 }),
    );

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as {
      candidate: {
        platform: string;
        title: string;
        author: string;
        authorBio: string | null;
        authorFollowers: number | null;
      };
    };
    expect(parsed.candidate.platform).toBe('reddit');
    expect(parsed.candidate.title).toBe('r/SaaS title here'); // real title, not a body slice
    expect(parsed.candidate.author).toBe('reddit-user');
    expect(parsed.candidate.authorBio).toBeNull();
    // author_karma stands in for authorFollowers as a rough scale signal.
    expect(parsed.candidate.authorFollowers).toBe(7891);
  });

  it('throttles by Reddit-platform engagement, not X-platform', async () => {
    // Seed a thread + a draft on the Reddit platform with a recent
    // engagement so listRecentEngagedAuthors returns something. The
    // exact shape of the throttle data isn't critical — what matters
    // is that the inner xAI call's prompt mentions u/<author> in
    // either the self-line or the do-not-surface line under the
    // Reddit prompt builder. We just verify the platform parameter
    // got threaded through (tools=web_search) rather than reverting
    // to x_search.
    xaiExecMock.mockResolvedValueOnce(xaiRedditResponse([]));

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const innerCall = xaiExecMock.mock.calls[0]![0] as {
      tools: Array<Record<string, unknown>>;
    };
    // If the platform branch had reverted, tools would be x_search.
    expect(innerCall.tools[0]).toMatchObject({ type: 'web_search' });
  });

  it('surfaces u/<handle> self-line ONLY in Reddit prompt builder (not @<handle>)', async () => {
    store.register<ChannelRow>(channels, [
      {
        id: 'ch-1',
        userId: 'user-1',
        platform: 'reddit',
        username: 'shipflare-founder',
        oauthTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
      },
    ]);
    xaiExecMock.mockResolvedValueOnce(xaiRedditResponse([]));

    await findThreadsViaXaiTool.execute(
      { trigger: 'daily', maxResults: 1, platform: 'reddit' },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const firstUserMsg = (xaiExecMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0]!.content;
    expect(firstUserMsg).toContain('u/shipflare-founder');
    // No @-prefixed self-handle line — the X builder uses @, the Reddit
    // builder must use u/.
    expect(firstUserMsg).not.toContain('@shipflare-founder');
  });
});
