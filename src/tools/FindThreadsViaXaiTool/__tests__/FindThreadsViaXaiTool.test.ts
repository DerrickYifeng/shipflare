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
    const msg = composeRefinementMessage(sigs, [
      'https://x.com/a',
      'https://x.com/b',
      'https://x.com/c',
    ]);
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
    const msg = composeRefinementMessage(sigs, []);
    // unknown_signal_xyz has no SIGNAL_NUDGE entry, so its nudge is dropped.
    // competitor_bio remains.
    expect(msg).toContain('competing tools');
    expect(msg).not.toContain('unknown_signal_xyz');
  });

  it('handles empty rejection map and empty strong list gracefully', () => {
    const msg = composeRefinementMessage(new Map(), []);
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
    );
    expect(msg).toContain('Value prop: (not specified)');
    expect(msg).toContain('Target audience: (not specified)');
    expect(msg).toContain('Keywords: (none)');
    expect(msg).not.toContain('FOUNDER INTENT');
    expect(msg).not.toContain('ICP RUBRIC');
  });
});
