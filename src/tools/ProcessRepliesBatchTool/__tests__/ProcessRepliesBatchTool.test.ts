/**
 * process_replies_batch unit tests.
 *
 * Mocks runForkSkill (drafting-reply only — the validating-draft fork
 * was intentionally dropped; recall < precision when it gated drafts)
 * and the two sub-tools (validate_draft + draft_reply) so the test
 * asserts the orchestration shape only — the 3-step pipeline order,
 * mechanical short-circuit, parallel batch fan-out, and the
 * skip-legacy short-circuit.
 *
 * Per-thread fork-skill calls = 1 (drafting-reply only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const runForkSkillMock = vi.hoisted(() => vi.fn());
vi.mock('@/skills/run-fork-skill', () => ({
  runForkSkill: runForkSkillMock,
}));

const validateDraftExecMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/ValidateDraftTool/ValidateDraftTool', () => ({
  validateDraftTool: { execute: validateDraftExecMock },
  VALIDATE_DRAFT_TOOL_NAME: 'validate_draft',
}));

const draftReplyExecMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/DraftReplyTool/DraftReplyTool', () => ({
  draftReplyTool: { execute: draftReplyExecMock },
  DRAFT_REPLY_TOOL_NAME: 'draft_reply',
}));

import {
  processRepliesBatchTool,
  PROCESS_REPLIES_BATCH_TOOL_NAME,
} from '../ProcessRepliesBatchTool';
import { threads, products } from '@/lib/db/schema';

interface ThreadRow {
  id: string;
  userId: string;
  externalId: string;
  platform: string;
  /** NULL for X threads (no Reddit-style subreddit equivalent). */
  community: string | null;
  title: string;
  url: string;
  body: string | null;
  author: string | null;
  authorBio: string | null;
  authorFollowers: number | null;
  canMentionProduct: boolean | null;
  mentionSignal: string | null;
  quotedText: string | null;
  quotedAuthor: string | null;
  inReplyToText: string | null;
  inReplyToAuthor: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  description: string;
  valueProp: string | null;
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

function seedThreads(
  store: InMemoryStore,
  rows: Partial<ThreadRow>[],
): void {
  const full: ThreadRow[] = rows.map((r, i) => ({
    id: r.id ?? `thread-${i}`,
    userId: r.userId ?? 'user-1',
    externalId: r.externalId ?? `ext-${i}`,
    platform: r.platform ?? 'x',
    // X threads default to NULL community; Reddit fixtures pass it explicitly.
    community: r.community ?? null,
    title: r.title ?? `thread ${i}`,
    url: r.url ?? `https://x.com/u/status/${i}`,
    body: r.body ?? 'we tried railway and it broke',
    author: r.author ?? 'alice',
    authorBio: r.authorBio ?? null,
    authorFollowers: r.authorFollowers ?? null,
    canMentionProduct:
      r.canMentionProduct === undefined ? true : r.canMentionProduct,
    mentionSignal:
      r.mentionSignal === undefined ? 'tool_question' : r.mentionSignal,
    quotedText: r.quotedText === undefined ? null : r.quotedText,
    quotedAuthor: r.quotedAuthor === undefined ? null : r.quotedAuthor,
    inReplyToText: r.inReplyToText === undefined ? null : r.inReplyToText,
    inReplyToAuthor:
      r.inReplyToAuthor === undefined ? null : r.inReplyToAuthor,
  }));
  store.register<ThreadRow>(threads, full);
}

function seedProduct(store: InMemoryStore): void {
  const row: ProductRow = {
    id: 'prod-1',
    name: 'TestProduct',
    description: 'a tool for indie devs',
    valueProp: 'fast deploys',
  };
  store.register<ProductRow>(products, [row]);
}

let store: InMemoryStore;
beforeEach(() => {
  vi.clearAllMocks();
  store = createInMemoryStore();
  seedProduct(store);
});

describe('processRepliesBatchTool', () => {
  it('exports the canonical name', () => {
    expect(PROCESS_REPLIES_BATCH_TOOL_NAME).toBe('process_replies_batch');
  });

  it('persists when mechanical passes (single thread, one fork-skill call)', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'we tried railway too — same.',
        whyItWorks: 'first-person',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(1);
    expect(draftReplyExecMock).toHaveBeenCalledOnce();
    // Drafting-reply only — no validating-draft fork.
    expect(runForkSkillMock).toHaveBeenCalledOnce();
    expect(runForkSkillMock.mock.calls[0]![0]).toBe('drafting-reply');
  });

  it('rejects on mechanical fail and short-circuits before persisting', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'a'.repeat(500),
        whyItWorks: '',
        confidence: 0.5,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({
      failures: [
        {
          validator: 'length',
          reason: 'too_long',
          limit: 240,
          length: 500,
          excess: 260,
        },
      ],
      warnings: [],
    });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(draftReplyExecMock).not.toHaveBeenCalled();
    // Only drafting-reply was called; no second fork (validating-draft
    // fork was removed entirely).
    expect(runForkSkillMock).toHaveBeenCalledOnce();
    expect(result.details[0]?.status).toBe('rejected_mechanical');
  });

  it('skips threads where canMentionProduct is null (legacy unjudged)', async () => {
    seedThreads(store, [
      { id: 't1', canMentionProduct: null, mentionSignal: null },
    ]);

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    // Tool didn't even call drafting-reply for legacy rows
    expect(runForkSkillMock).not.toHaveBeenCalled();
    expect(result.details[0]?.status).toBe('skipped_legacy_unjudged');
  });

  it('parallelizes across multiple threads via Promise.all', async () => {
    seedThreads(store, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
    runForkSkillMock.mockImplementation(async (skillName: string) => {
      if (skillName === 'drafting-reply') {
        return {
          result: { draftBody: 'd', whyItWorks: '', confidence: 0.7 },
          usage: {},
        };
      }
      throw new Error(`unexpected skill: ${skillName}`);
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd' });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1', 't2', 't3'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(3);
    // Three drafting-reply calls, one per thread; no validating-draft.
    expect(runForkSkillMock).toHaveBeenCalledTimes(3);
  });

  it('returns empty result when no threadIds match in DB (no fork calls)', async () => {
    // No threads seeded; the inArray lookup returns empty
    const result = await processRepliesBatchTool.execute(
      { threadIds: ['nonexistent'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );
    expect(result.itemsScanned).toBe(0);
    expect(runForkSkillMock).not.toHaveBeenCalled();
  });

  it("one thread's drafting-reply rejection does NOT lose the whole batch", async () => {
    seedThreads(store, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
    let firstCall = true;
    runForkSkillMock.mockImplementation(async (skillName: string) => {
      if (firstCall) {
        // t1's first fork-skill (drafting-reply) rejects — the whole
        // processOne(t1) promise rejects mid-pipeline.
        firstCall = false;
        throw new Error('xAI quota exhausted');
      }
      if (skillName === 'drafting-reply') {
        return {
          result: { draftBody: 'd', whyItWorks: '', confidence: 0.7 },
          usage: {},
        };
      }
      throw new Error(`unexpected skill: ${skillName}`);
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd' });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1', 't2', 't3'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(2);
    expect(result.draftsSkipped).toBe(1);
    expect(result.details.find((d) => d.threadId === 't1')?.status).toBe(
      'errored',
    );
    expect(result.details.find((d) => d.threadId === 't1')?.reason).toContain(
      'xAI quota exhausted',
    );
  });

  it('passes thread.authorBio + thread.authorFollowers through to drafting-reply', async () => {
    seedThreads(store, [
      {
        id: 't1',
        authorBio: 'building thing — indie hacker',
        authorFollowers: 1234,
      },
    ]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'we tried railway too — same.',
        whyItWorks: 'first-person',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(runForkSkillMock).toHaveBeenCalledOnce();
    const callArgs = runForkSkillMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('drafting-reply');
    const argsJson = callArgs[1] as string;
    const parsed = JSON.parse(argsJson) as {
      thread: { authorBio: string | null; authorFollowers: number | null };
    };
    expect(parsed.thread.authorBio).toBe('building thing — indie hacker');
    expect(parsed.thread.authorFollowers).toBe(1234);
  });

  it('passes null authorBio + authorFollowers for legacy rows', async () => {
    seedThreads(store, [{ id: 't1' }]); // defaults: authorBio=null, authorFollowers=null
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'we tried railway too — same.',
        whyItWorks: 'first-person',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as {
      thread: { authorBio: string | null; authorFollowers: number | null };
    };
    expect(parsed.thread.authorBio).toBeNull();
    expect(parsed.thread.authorFollowers).toBeNull();
  });

  it('passes quotedText + inReplyToText through to drafting-reply input', async () => {
    seedThreads(store, [
      {
        id: 't1',
        author: 'anumness',
        body: 'Marketing has been the biggest frustration. Tried Apple Search Ads.',
        quotedText: 'OMG this actually worked — database is complete',
        quotedAuthor: 'anumness',
        inReplyToText: null,
        inReplyToAuthor: null,
      },
    ]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'the database win was wild — same shipper energy.',
        whyItWorks: 'context-aware',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(runForkSkillMock).toHaveBeenCalledOnce();
    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as {
      thread: {
        quotedText: string | null;
        quotedAuthor: string | null;
        inReplyToText: string | null;
        inReplyToAuthor: string | null;
      };
    };
    expect(parsed.thread.quotedText).toBe(
      'OMG this actually worked — database is complete',
    );
    expect(parsed.thread.quotedAuthor).toBe('anumness');
    expect(parsed.thread.inReplyToText).toBeNull();
    expect(parsed.thread.inReplyToAuthor).toBeNull();
  });

  it('passes null conversation fields for plain (non-quote, non-reply) threads', async () => {
    seedThreads(store, [{ id: 't1' }]); // defaults: all four conversation fields null
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'we tried railway too — same.',
        whyItWorks: '',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as {
      thread: {
        quotedText: string | null;
        inReplyToText: string | null;
      };
    };
    expect(parsed.thread.quotedText).toBeNull();
    expect(parsed.thread.inReplyToText).toBeNull();
  });

  it('rejects threadIds.length > 10 at Zod boundary', () => {
    const parse = processRepliesBatchTool.inputSchema.safeParse({
      threadIds: Array.from({ length: 11 }, (_, i) => `t${i}`),
    });
    expect(parse.success).toBe(false);
    // Sanity-check: 10 still passes.
    const ok = processRepliesBatchTool.inputSchema.safeParse({
      threadIds: Array.from({ length: 10 }, (_, i) => `t${i}`),
    });
    expect(ok.success).toBe(true);
  });

  it('treats malformed drafting-reply output as errored, does not crash', async () => {
    seedThreads(store, [{ id: 't1' }]);
    // Returned object missing draftBody — pre-fix this would crash
    // downstream when validate_draft tries text.split(...) on undefined.
    runForkSkillMock.mockResolvedValueOnce({
      result: { whyItWorks: 'no body', confidence: 0.5 },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(result.draftsSkipped).toBe(1);
    expect(result.details[0]?.status).toBe('errored');
    expect(result.details[0]?.reason).toContain('drafting-reply');
    // Mechanical / persist were never invoked because draft was null.
    expect(validateDraftExecMock).not.toHaveBeenCalled();
    expect(draftReplyExecMock).not.toHaveBeenCalled();
  });

  it('short-circuits to skipped_subreddit_rule_conflict when drafting flags the thread (no validate_draft)', async () => {
    seedThreads(store, [{ id: 't1', platform: 'reddit', community: 'SaaS' }]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: '',
        whyItWorks: 'no_self_promotion',
        confidence: 0,
        flagged: true,
        flagReason: 'subreddit rule conflict',
      },
      usage: {},
    });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(result.draftsSkipped).toBe(1);
    expect(result.details[0]?.status).toBe('skipped_subreddit_rule_conflict');
    expect(result.details[0]?.reason).toBe('subreddit rule conflict');
    // Critical: validate_draft must NOT be called on the empty body —
    // its Zod input rejects empty text with a cryptic message that
    // would surface as `errored` instead of the safe-skip status.
    expect(validateDraftExecMock).not.toHaveBeenCalled();
    expect(draftReplyExecMock).not.toHaveBeenCalled();
    expect(runForkSkillMock).toHaveBeenCalledOnce();
  });

  it('emits live progress at start and finish so UI tool card updates in real-time', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'we tried railway too — same.',
        whyItWorks: 'first-person',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    const emit = vi.fn();
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    ctx.emitProgress = emit;

    await processRepliesBatchTool.execute({ threadIds: ['t1'] }, ctx);

    // Start event: announces drafting in parallel
    expect(emit).toHaveBeenCalledWith(
      'process_replies_batch',
      expect.stringContaining('Drafting'),
      expect.any(Object),
    );
    // Finish event: announces drafted/skipped totals
    expect(emit).toHaveBeenCalledWith(
      'process_replies_batch',
      expect.stringContaining('drafted'),
      expect.any(Object),
    );
  });
});
