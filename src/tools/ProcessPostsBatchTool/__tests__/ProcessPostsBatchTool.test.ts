/**
 * process_posts_batch unit tests.
 *
 * Mocks runForkSkill (drafting-post + validating-draft) and the two
 * sub-tools (validate_draft + draft_post) so the test asserts the
 * orchestration shape only — the 4-step pipeline order, REVISE retry
 * behavior, slop-fingerprint → voice-cue mapping, and the parallel
 * batch fan-out. Unlike the reply path, there is NO judging step
 * and NO skip-legacy branch — allocation is the gate.
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

  it('persists when mechanical + validating both PASS (single plan_item)', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
    runForkSkillMock
      .mockResolvedValueOnce({
        result: {
          draftBody: 'shipped first revenue today: $42 MRR',
          whyItWorks: 'first-person milestone',
          confidence: 0.7,
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { verdict: 'PASS', score: 0.85, slopFingerprint: [] },
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
  });

  it('rejects on mechanical fail without calling validating-draft', async () => {
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
    // validating-draft (the LLM) NOT called when mechanical failed
    expect(runForkSkillMock).toHaveBeenCalledOnce();
  });

  it('retries with voice cue on REVISE; persists if retry passes', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
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
          draftBody: 'first revenue: $42 MRR. ten months in.',
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
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(1);
    expect(runForkSkillMock).toHaveBeenCalledTimes(4);
    // The retry-draft fork-skill call (3rd call, index 2) must include the voice cue
    const retryDraftCall = runForkSkillMock.mock.calls[2];
    expect(retryDraftCall[1]).toContain('opener');
  });

  it('persists with [needs human review] flag when retry still REVISEs', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
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
    draftPostExecMock.mockResolvedValue({ planItemId: 'p1' });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(1);
    expect(draftPostExecMock).toHaveBeenCalledOnce();
    const persistArgs = draftPostExecMock.mock.calls[0]![0] as {
      whyItWorks: string;
    };
    expect(persistArgs.whyItWorks).toContain('needs human review');
  });

  it('skips when validating returns FAIL', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
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

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(0);
    expect(draftPostExecMock).not.toHaveBeenCalled();
  });

  it('parallelizes across multiple plan_items via Promise.all', async () => {
    seedPlanItems(store, [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
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
    draftPostExecMock.mockResolvedValue({ planItemId: 'p' });

    const result = await processPostsBatchTool.execute(
      { planItemIds: ['p1', 'p2', 'p3'] },
      makeCtx(store, { userId: 'user-1', productId: 'prod-1' }),
    );

    expect(result.draftsCreated).toBe(3);
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

  it('truncates whyItWorks on flag-persist branch so total stays <= 500 chars', async () => {
    seedPlanItems(store, [{ id: 'p1' }]);
    // 480-char retry whyItWorks + flagSuffix would exceed 500.
    const longWhy = 'w'.repeat(480);
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
        result: { draftBody: 'd2', whyItWorks: longWhy, confidence: 0.7 },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: {
          verdict: 'REVISE',
          score: 0.5,
          slopFingerprint: ['fortune_cookie_closer', 'preamble_opener'],
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
    const persistArgs = draftPostExecMock.mock.calls[0]![0] as {
      whyItWorks: string;
    };
    expect(persistArgs.whyItWorks).toContain('needs human review');
    // Stays within DraftPostTool's z.string().max(500) bound.
    expect(persistArgs.whyItWorks.length).toBeLessThanOrEqual(500);
  });

  it("one item's drafting-post rejection does NOT lose the whole batch", async () => {
    seedPlanItems(store, [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
    runForkSkillMock
      // p1's first fork-skill (drafting-post) rejects — the whole
      // processOne(p1) promise rejects mid-pipeline.
      .mockRejectedValueOnce(new Error('xAI quota exhausted'))
      // p2 + p3 each need 2 fork-skill calls (draft + validating).
      .mockResolvedValue({
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
        params: { pillar: 'milestone', theme: 'first revenue' },
      },
    ]);
    runForkSkillMock
      .mockResolvedValueOnce({
        result: {
          draftBody: '$42 MRR. first dollar.',
          whyItWorks: 'compound-phase milestone',
          confidence: 0.7,
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        result: { verdict: 'PASS', score: 0.85, slopFingerprint: [] },
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
});
