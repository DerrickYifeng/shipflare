/**
 * process_replies_batch unit tests.
 *
 * Mocks runForkSkill (drafting-reply + validating-draft) and the two
 * sub-tools (validate_draft + draft_reply) so the test asserts the
 * orchestration shape only — the 4-step pipeline order, REVISE retry
 * behavior, slop-fingerprint → voice-cue mapping, and the
 * skip-legacy short-circuit.
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
  community: string;
  title: string;
  url: string;
  body: string | null;
  author: string | null;
  canMentionProduct: boolean | null;
  mentionSignal: string | null;
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
    community: r.community ?? 'home',
    title: r.title ?? `thread ${i}`,
    url: r.url ?? `https://x.com/u/status/${i}`,
    body: r.body ?? 'we tried railway and it broke',
    author: r.author ?? 'alice',
    canMentionProduct:
      r.canMentionProduct === undefined ? true : r.canMentionProduct,
    mentionSignal:
      r.mentionSignal === undefined ? 'tool_question' : r.mentionSignal,
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

  it('persists when mechanical + validating both PASS (single thread)', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock
      .mockResolvedValueOnce({
        result: {
          draftBody: 'we tried railway too — same.',
          whyItWorks: 'first-person',
          confidence: 0.7,
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { verdict: 'PASS', score: 0.85, slopFingerprint: [] },
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
  });

  it('rejects on mechanical fail without calling validating-draft', async () => {
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
    // validating-draft (the LLM) NOT called when mechanical failed
    expect(runForkSkillMock).toHaveBeenCalledOnce();
  });

  it('retries with voice cue on REVISE; persists if retry passes', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock
      .mockResolvedValueOnce({
        result: {
          draftBody: 'great post! the real win is...',
          whyItWorks: '',
          confidence: 0.6,
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: {
          verdict: 'REVISE',
          score: 0.5,
          slopFingerprint: ['preamble_opener'],
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: {
          draftBody: 'we tried railway — broke at edge case',
          whyItWorks: '',
          confidence: 0.7,
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { verdict: 'PASS', score: 0.8, slopFingerprint: [] },
        usage: {},
      });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd1' });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(1);
    expect(runForkSkillMock).toHaveBeenCalledTimes(4);
    // The retry-draft fork-skill call (3rd call, index 2) must include the voice cue
    const retryDraftCall = runForkSkillMock.mock.calls[2];
    expect(retryDraftCall[1]).toContain('opener');
  });

  it('persists with [needs human review] flag when retry still REVISEs', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock
      .mockResolvedValueOnce({
        result: { draftBody: 'd1', whyItWorks: '', confidence: 0.6 },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: {
          verdict: 'REVISE',
          score: 0.5,
          slopFingerprint: ['fortune_cookie_closer'],
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { draftBody: 'd2', whyItWorks: '', confidence: 0.6 },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: {
          verdict: 'REVISE',
          score: 0.5,
          slopFingerprint: ['fortune_cookie_closer'],
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
    const persistArgs = draftReplyExecMock.mock.calls[0][0];
    expect(persistArgs.whyItWorks).toContain('needs human review');
  });

  it('skips when validating returns FAIL', async () => {
    seedThreads(store, [{ id: 't1' }]);
    runForkSkillMock
      .mockResolvedValueOnce({
        result: { draftBody: 'd1', whyItWorks: '', confidence: 0.6 },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: {
          verdict: 'FAIL',
          score: 0.1,
          slopFingerprint: ['banned_vocabulary'],
        },
        usage: {},
      });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(draftReplyExecMock).not.toHaveBeenCalled();
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
  });

  it('parallelizes across multiple threads via Promise.all', async () => {
    seedThreads(store, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
    runForkSkillMock.mockResolvedValue({
      result: {
        draftBody: 'd',
        whyItWorks: '',
        confidence: 0.7,
        verdict: 'PASS',
        score: 0.8,
        slopFingerprint: [],
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftReplyExecMock.mockResolvedValue({ id: 'd' });

    const result = await processRepliesBatchTool.execute(
      { threadIds: ['t1', 't2', 't3'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(3);
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
});
