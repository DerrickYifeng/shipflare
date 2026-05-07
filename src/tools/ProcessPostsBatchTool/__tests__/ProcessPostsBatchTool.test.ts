/**
 * process_posts_batch unit tests.
 *
 * Mocks runForkSkill (drafting-post only — the validating-draft fork
 * was intentionally dropped; recall < precision when it gated drafts)
 * and the two sub-tools (validate_draft + draft_post) so the test
 * asserts the orchestration shape only — the 3-step pipeline order,
 * mechanical short-circuit, and the parallel batch fan-out. Unlike
 * the reply path, there is NO judging step and NO skip-legacy branch
 * — allocation is the gate.
 *
 * Per-item fork-skill calls = 1 (drafting-post only).
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

const draftPostExecMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/DraftPostTool/DraftPostTool', () => ({
  draftPostTool: { execute: draftPostExecMock },
  DRAFT_POST_TOOL_NAME: 'draft_post',
}));

import {
  processPostsBatchTool,
  PROCESS_POSTS_BATCH_TOOL_NAME,
} from '../ProcessPostsBatchTool';
import { planItems, products } from '@/lib/db/schema';

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  planId: string;
  kind: string;
  state: string;
  userAction: string;
  phase: string;
  channel: string | null;
  scheduledAt: Date;
  skillName: string | null;
  params: Record<string, unknown>;
  output: Record<string, unknown> | null;
  title: string;
  description: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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

function seedPlanItems(
  store: InMemoryStore,
  rows: Partial<PlanItemRow>[],
): void {
  const now = new Date();
  const full: PlanItemRow[] = rows.map((r, i) => ({
    id: r.id ?? `pi-${i}`,
    userId: r.userId ?? 'user-1',
    productId: r.productId ?? 'prod-1',
    planId: r.planId ?? 'plan-1',
    kind: r.kind ?? 'content_post',
    state: r.state ?? 'planned',
    userAction: r.userAction ?? 'auto',
    phase: r.phase ?? 'foundation',
    channel: r.channel ?? 'x',
    scheduledAt: r.scheduledAt ?? now,
    skillName: r.skillName ?? null,
    params: r.params ?? {},
    output: r.output ?? null,
    title: r.title ?? `post ${i}`,
    description: r.description ?? `body ${i}`,
    completedAt: r.completedAt ?? null,
    createdAt: r.createdAt ?? now,
    updatedAt: r.updatedAt ?? now,
  }));
  store.register<PlanItemRow>(planItems, full);
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

describe('processPostsBatchTool', () => {
  it('exports the canonical name', () => {
    expect(PROCESS_POSTS_BATCH_TOOL_NAME).toBe('process_posts_batch');
  });

  it('persists when mechanical passes (single plan_item, one fork-skill call)', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'shipped first revenue today: $42 MRR',
        whyItWorks: 'first-person milestone',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(1);
    expect(draftPostExecMock).toHaveBeenCalledOnce();
    // validate_draft is called with kind='post' (not 'reply')
    const validateCall = validateDraftExecMock.mock.calls[0]![0] as {
      kind: string;
    };
    expect(validateCall.kind).toBe('post');
    // Only drafting-post — no validating-draft fork.
    expect(runForkSkillMock).toHaveBeenCalledOnce();
    expect(runForkSkillMock.mock.calls[0]![0]).toBe('drafting-post');
  });

  it('rejects on mechanical fail and short-circuits before persisting', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
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
          limit: 280,
          length: 500,
          excess: 220,
        },
      ],
      warnings: [],
    });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(draftPostExecMock).not.toHaveBeenCalled();
    // Only drafting-post was called; no second fork (validating-draft
    // fork was removed entirely).
    expect(runForkSkillMock).toHaveBeenCalledOnce();
    expect(result.details[0]?.status).toBe('rejected_mechanical');
  });

  it('parallelizes across multiple plan_items via Promise.all', async () => {
    seedPlanItems(store, [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
    runForkSkillMock.mockImplementation(async (skillName: string) => {
      if (skillName === 'drafting-post') {
        return {
          result: { draftBody: 'd', whyItWorks: '', confidence: 0.7 },
          usage: {},
        };
      }
      throw new Error(`unexpected skill: ${skillName}`);
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p' });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1', 'p2', 'p3'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(3);
    // Three drafting-post calls, one per item; no validating-draft.
    expect(runForkSkillMock).toHaveBeenCalledTimes(3);
  });

  it('returns empty result when no planItemIds match in DB (no fork calls)', async () => {
    // No items seeded; the inArray lookup returns empty
    const result = await processPostsBatchTool.execute(
      { planItemIds: ['nonexistent'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );
    expect(result.itemsScanned).toBe(0);
    expect(runForkSkillMock).not.toHaveBeenCalled();
  });

  it("one item's drafting-post rejection does NOT lose the whole batch", async () => {
    seedPlanItems(store, [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
    let firstCall = true;
    runForkSkillMock.mockImplementation(async (skillName: string) => {
      if (firstCall) {
        // p1's first fork-skill (drafting-post) rejects — the whole
        // processOne(p1) promise rejects mid-pipeline.
        firstCall = false;
        throw new Error('xAI quota exhausted');
      }
      if (skillName === 'drafting-post') {
        return {
          result: { draftBody: 'd', whyItWorks: '', confidence: 0.7 },
          usage: {},
        };
      }
      throw new Error(`unexpected skill: ${skillName}`);
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p' });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1', 'p2', 'p3'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(2);
    expect(result.draftsSkipped).toBe(1);
    expect(result.details.find((d) => d.planItemId === 'p1')?.status).toBe(
      'errored',
    );
    expect(
      result.details.find((d) => d.planItemId === 'p1')?.reason,
    ).toContain('xAI quota exhausted');
  });

  it('rejects planItemIds.length > 10 at Zod boundary', () => {
    const parse = processPostsBatchTool.inputSchema.safeParse({
      planItemIds: Array.from({ length: 11 }, (_, i) => `p${i}`),
    });
    expect(parse.success).toBe(false);
    // Sanity-check: 10 still passes.
    const ok = processPostsBatchTool.inputSchema.safeParse({
      planItemIds: Array.from({ length: 10 }, (_, i) => `p${i}`),
    });
    expect(ok.success).toBe(true);
  });

  it('reads plan_item from DB and passes phase + params to drafting-post', async () => {
    seedPlanItems(store, [
      {
        id: 'p1',
        phase: 'compound',
        params: { format: 'milestone', theme: 'first revenue' },
      },
    ]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: '$42 MRR. first dollar.',
        whyItWorks: 'compound-phase milestone',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const draftCall = runForkSkillMock.mock.calls[0]!;
    // 1st arg is the skill name, 2nd is the JSON-stringified args payload
    expect(draftCall[0]).toBe('drafting-post');
    expect(draftCall[1]).toContain('compound');
    expect(draftCall[1]).toContain('milestone');
  });

  it('treats malformed drafting-post output as errored, does not crash', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
    // Returned object missing draftBody — pre-fix this would crash
    // downstream when validate_draft tries text.split(...) on undefined.
    runForkSkillMock.mockResolvedValueOnce({
      result: { whyItWorks: 'no body', confidence: 0.5 },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(result.draftsSkipped).toBe(1);
    expect(result.details[0]?.status).toBe('errored');
    expect(result.details[0]?.reason).toContain('drafting-post');
    // Mechanical / persist were never invoked because draft was null.
    expect(validateDraftExecMock).not.toHaveBeenCalled();
    expect(draftPostExecMock).not.toHaveBeenCalled();
  });

  it('short-circuits to skipped_subreddit_rule_conflict when drafting flags the item (no validate_draft)', async () => {
    seedPlanItems(store, [
      {
        id: 'p1',
        channel: 'reddit',
        params: { format: 'milestone', subreddit: 'SaaS' },
      },
    ]);
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

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
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
    expect(draftPostExecMock).not.toHaveBeenCalled();
    expect(runForkSkillMock).toHaveBeenCalledOnce();
  });

  it('plumbs params.subreddit into top-level targetSubreddit for reddit posts', async () => {
    seedPlanItems(store, [
      {
        id: 'p1',
        channel: 'reddit',
        params: { format: 'milestone', subreddit: 'SaaS' },
      },
    ]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'a real reddit body about shipping',
        whyItWorks: 'milestone',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as {
      targetSubreddit?: string;
      channel: string;
    };
    expect(parsed.channel).toBe('reddit');
    expect(parsed.targetSubreddit).toBe('SaaS');
  });

  it('omits targetSubreddit for non-reddit channels even if params.subreddit exists', async () => {
    seedPlanItems(store, [
      {
        id: 'p1',
        channel: 'x',
        params: { format: 'milestone', subreddit: 'SaaS' },
      },
    ]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'shipped today',
        whyItWorks: 'milestone',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    const argsJson = runForkSkillMock.mock.calls[0]![1] as string;
    const parsed = JSON.parse(argsJson) as { targetSubreddit?: string };
    expect(parsed.targetSubreddit).toBeUndefined();
  });

  it('emits live progress at start and finish so UI tool card updates in real-time', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
    runForkSkillMock.mockResolvedValueOnce({
      result: {
        draftBody: 'shipped first revenue today: $42 MRR',
        whyItWorks: 'first-person milestone',
        confidence: 0.7,
      },
      usage: {},
    });
    validateDraftExecMock.mockResolvedValue({ failures: [], warnings: [] });
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    const emit = vi.fn();
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    ctx.emitProgress = emit;

    await processPostsBatchTool.execute({ planItemIds: ['p1'] }, ctx);

    // Start event: announces drafting in parallel
    expect(emit).toHaveBeenCalledWith(
      'process_posts_batch',
      expect.stringContaining('Drafting'),
      expect.any(Object),
    );
    // Finish event: announces drafted/skipped totals
    expect(emit).toHaveBeenCalledWith(
      'process_posts_batch',
      expect.stringContaining('drafted'),
      expect.any(Object),
    );
  });
});
