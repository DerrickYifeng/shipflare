/**
 * draft_post unit tests.
 *
 * Covers the happy path (plan_item + product loaded, sideQuery stub yields
 * text, row is updated), ownership guards, channel-resolution failures,
 * and schema validation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import type Anthropic from '@anthropic-ai/sdk';
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

import { draftPostTool } from '../DraftPostTool';
import type { SideQueryOptions } from '@/core/api-client';
import { planItems, products } from '@/lib/db/schema';

type SideQueryStub = (opts: SideQueryOptions) => Promise<Anthropic.Messages.Message>;

interface ProductRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  valueProp: string | null;
}

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
  params: unknown;
  output: unknown;
  title: string;
  description: string | null;
}

function mockResponse(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text, citations: [] }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Messages.Message;
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

function seedHappyPath(store: InMemoryStore): { planItemId: string } {
  store.register<ProductRow>(products, [
    {
      id: 'prod-1',
      userId: 'user-1',
      name: 'ShipFlare',
      description: 'Marketing pipeline for indie founders',
      valueProp: 'Turn changelog into X posts',
    },
  ]);
  const planItemId = 'item-1';
  store.register<PlanItemRow>(planItems, [
    {
      id: planItemId,
      userId: 'user-1',
      productId: 'prod-1',
      planId: 'plan-1',
      kind: 'content_post',
      state: 'planned',
      userAction: 'approve',
      phase: 'foundation',
      channel: 'x',
      scheduledAt: new Date('2026-04-22T09:00:00Z'),
      skillName: null,
      params: { angle: 'claim', topic: 'first plan' },
      output: null,
      title: 'Announce the new planner',
      description: 'Build-in-public update on the planner shipping',
    },
  ]);
  return { planItemId };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
});

describe('draftPostTool', () => {
  it('generates a draft body, writes to plan_items.output, transitions to drafted', async () => {
    const { planItemId } = seedHappyPath(store);
    const sideQueryStub: SideQueryStub = vi.fn(async (_opts: SideQueryOptions) =>
      mockResponse('Week 1 of building the planner: 4 skills deleted, 2 agents shipped. #buildinpublic'),
    );
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: sideQueryStub,
    });

    const result = await draftPostTool.execute(
      { planItemId, context: { angle: 'claim', voice: 'terse' } },
      ctx,
    );

    expect(result.planItemId).toBe(planItemId);
    expect(result.channel).toBe('x');
    expect(result.draft_body).toContain('#buildinpublic');
    const spy = vi.mocked(sideQueryStub);
    expect(spy).toHaveBeenCalledTimes(1);

    const stubCall = spy.mock.calls[0]![0];
    expect(stubCall.model).toBe('claude-haiku-4-5-20251001');
    expect(stubCall.system).toContain('X (Twitter)');
    expect(String(stubCall.messages[0]!.content)).toContain('ShipFlare');
    expect(String(stubCall.messages[0]!.content)).toContain(
      'Announce the new planner',
    );
    expect(String(stubCall.messages[0]!.content)).toContain('angle: claim');

    const rows = store.get<PlanItemRow>(planItems);
    expect(rows).toHaveLength(1);
    const updated = rows[0]!;
    expect(updated.state).toBe('drafted');
    expect((updated.output as Record<string, unknown>).draft_body).toBe(
      result.draft_body,
    );
    expect((updated.output as Record<string, unknown>).channel).toBe('x');
  });

  it('silently drops unknown context keys instead of bouncing the call', async () => {
    // Regression: post-writer LLMs habitually pass `channel`/`phase`/`topic`
    // inside `context`. The earlier `.strict()` schema rejected these and
    // forced a self-recovery turn (~600ms each). The schema now strips
    // unknown keys and accepts the call on the first try. `topic` is now a
    // documented hint that flows into the brief.
    const { planItemId } = seedHappyPath(store);
    const sideQueryStub: SideQueryStub = vi.fn(async (_opts: SideQueryOptions) =>
      mockResponse('Shipping the planner today. #buildinpublic'),
    );
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: sideQueryStub,
    });

    // The runtime parses the input through `inputSchema` before handing
    // it to `execute` (see core/tool-executor). We replicate that here so
    // the strip-unknown behaviour from the zod schema actually takes
    // effect — tests that pre-parse mirror what the agent loop does.
    const rawInput = {
      planItemId,
      context: {
        angle: 'claim',
        topic: 'shipping cadence',
        // unknown keys — should be silently stripped by the schema
        channel: 'x',
        phase: 'foundation',
      },
    };
    const parsed = draftPostTool.inputSchema.parse(rawInput);
    const result = await draftPostTool.execute(parsed, ctx);

    expect(result.channel).toBe('x');
    expect(vi.mocked(sideQueryStub)).toHaveBeenCalledTimes(1);
    const userMsg = String(
      vi.mocked(sideQueryStub).mock.calls[0]![0].messages[0]!.content,
    );
    // Known keys flow into the brief…
    expect(userMsg).toContain('angle: claim');
    expect(userMsg).toContain('topic: shipping cadence');
    // …unknown keys silently dropped.
    expect(userMsg).not.toContain('phase: foundation');
  });

  it('picks the reddit prompt when the plan_item channel is reddit', async () => {
    const { planItemId } = seedHappyPath(store);
    // Flip channel on the seeded row.
    store.get<PlanItemRow>(planItems)[0]!.channel = 'reddit';

    const sideQueryStub: SideQueryStub = vi.fn(async (_opts: SideQueryOptions) =>
      mockResponse('Here is what I learned shipping the planner this week...'),
    );
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: sideQueryStub,
    });

    const result = await draftPostTool.execute({ planItemId }, ctx);

    expect(result.channel).toBe('reddit');
    const stubCall = vi.mocked(sideQueryStub).mock.calls[0]![0];
    expect(stubCall.system).toContain('Reddit');
    expect(stubCall.system).not.toContain('X (Twitter)');
  });

  it('rejects a plan_item owned by a different user+product', async () => {
    const { planItemId } = seedHappyPath(store);
    const ctx = makeCtx(store, {
      userId: 'other-user',
      productId: 'prod-1',
      sideQuery: vi.fn(),
    });

    await expect(
      draftPostTool.execute({ planItemId }, ctx),
    ).rejects.toThrow(/not owned by the current/);
    // Row should stay 'planned' (no update fired).
    expect(store.get<PlanItemRow>(planItems)[0]!.state).toBe('planned');
  });

  it('rejects when the plan_item kind is not content_post', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.kind = 'setup_task';
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: vi.fn(),
    });
    await expect(
      draftPostTool.execute({ planItemId }, ctx),
    ).rejects.toThrow(/expected "content_post"/);
  });

  it('rejects when the plan_item has no channel', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.channel = null;
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: vi.fn(),
    });
    await expect(
      draftPostTool.execute({ planItemId }, ctx),
    ).rejects.toThrow(/no channel set/);
  });

  it('rejects an unsupported channel', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.channel = 'linkedin';
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: vi.fn(),
    });
    await expect(
      draftPostTool.execute({ planItemId }, ctx),
    ).rejects.toThrow(/unsupported channel "linkedin"/);
  });

  it('rejects invalid input via the schema', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { planItemId: '' } as any;
    const parse = draftPostTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('rejects when sideQuery returns no text block', async () => {
    const { planItemId } = seedHappyPath(store);
    const sideQueryStub: SideQueryStub = vi.fn(async (_opts: SideQueryOptions) =>
      ({
        content: [],
      }) as unknown as Anthropic.Messages.Message,
    );
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: sideQueryStub,
    });
    await expect(
      draftPostTool.execute({ planItemId }, ctx),
    ).rejects.toThrow(/no text block/);
  });

  it('preserves prior output keys on subsequent drafts', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.output = {
      confidence: 0.7,
      whyItWorks: 'grounded in metric',
    };
    const sideQueryStub: SideQueryStub = vi.fn(async (_opts: SideQueryOptions) =>
      mockResponse('Redraft — cleaner hook, still grounded in metric.'),
    );
    const ctx = makeCtx(store, {
      userId: 'user-1',
      productId: 'prod-1',
      sideQuery: sideQueryStub,
    });

    await draftPostTool.execute({ planItemId }, ctx);

    const updated = store.get<PlanItemRow>(planItems)[0]!
      .output as Record<string, unknown>;
    expect(updated.confidence).toBe(0.7);
    expect(updated.whyItWorks).toBe('grounded in metric');
    expect(updated.draft_body).toContain('Redraft');
  });
});
