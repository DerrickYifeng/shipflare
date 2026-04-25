import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(),
}));
vi.mock('@/lib/queue', () => ({
  enqueueReview: vi.fn(),
}));

// db is mocked so each test can control the rows returned by the
// idempotency select + the product lookup.
const dbSelectMock = vi.fn();
const dbInsertMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
    insert: (...args: unknown[]) => dbInsertMock(...args),
  },
}));

import { draftSingleReplyTool } from '../DraftSingleReplyTool';
import { runSkill } from '@/core/skill-runner';
import { enqueueReview } from '@/lib/queue';

// Minimal ToolContext-shaped adapter. The real tool reads deps via
// `ctx.get(key)` — see `src/tools/context-helpers.ts:readDomainDeps`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(deps: Record<string, unknown>): any {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

function buildSelectChain(rows: unknown[]) {
  const chain: {
    from: () => typeof chain;
    where: () => typeof chain;
    limit: () => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown) => Promise<unknown>;
  } = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve) => Promise.resolve(resolve(rows)),
  };
  return chain;
}

function buildInsertChain() {
  // draft insert path: db.insert(drafts).values(...) → Promise<void>.
  return {
    values: vi.fn(() => Promise.resolve(undefined)),
  };
}

const PRODUCT_ROW = {
  id: 'p1',
  name: 'Shipflare',
  description: 'ship things',
  valueProp: null,
  keywords: ['ship', 'deploy'],
};

describe('draft_single_reply tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dbInsertMock.mockReset();
    dbInsertMock.mockReturnValue(buildInsertChain());
  });

  it('drafts a reply for a queued thread and enqueues review', async () => {
    // select #1: idempotency check → no existing draft
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
    // select #2: product lookup
    dbSelectMock.mockReturnValueOnce(buildSelectChain([PRODUCT_ROW]));

    vi.mocked(runSkill).mockResolvedValueOnce({
      results: [
        {
          replyText: 'cool, have you tried shipflare?',
          confidence: 0.8,
          strategy: 'supportive_peer',
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.003 },
      errors: [],
    } as never);

    const result = await draftSingleReplyTool.execute(
      {
        threadId: '00000000-0000-0000-0000-000000000001',
        externalId: 'tweet-1',
        body: 'looking for shipflare alternatives',
        author: 'alice',
        platform: 'x',
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.status).toBe('drafted');
    expect(result.draftId).toMatch(/[0-9a-f-]{36}/);
    expect(enqueueReview).toHaveBeenCalledTimes(1);
  });

  it('returns skipped when the drafter chooses not to reply', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([])); // idempotency
    dbSelectMock.mockReturnValueOnce(buildSelectChain([PRODUCT_ROW])); // product

    vi.mocked(runSkill).mockResolvedValueOnce({
      results: [
        {
          replyText: '',
          confidence: 0.1,
          strategy: 'skip',
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.001 },
      errors: [],
    } as never);

    const result = await draftSingleReplyTool.execute(
      {
        threadId: '00000000-0000-0000-0000-000000000002',
        externalId: 'tweet-1',
        body: 'random unrelated tweet',
        author: 'bob',
        platform: 'x',
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.status).toBe('skipped');
    expect(result.draftId).toBeNull();
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  it('returns already_exists for a thread that already has a draft', async () => {
    // idempotency check returns an existing row → short-circuit
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        { id: 'draft-existing-1', replyBody: 'prior reply text' },
      ]),
    );

    const result = await draftSingleReplyTool.execute(
      {
        threadId: '00000000-0000-0000-0000-000000000003',
        externalId: 'tweet-1',
        body: 'whatever',
        author: 'alice',
        platform: 'x',
      },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.status).toBe('already_exists');
    expect(result.draftId).toBe('draft-existing-1');
    expect(result.body).toBe('prior reply text');
    expect(runSkill).not.toHaveBeenCalled();
    expect(enqueueReview).not.toHaveBeenCalled();
  });
});
