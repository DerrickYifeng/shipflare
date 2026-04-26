/**
 * draft_post unit tests.
 *
 * After the post-writer refactor, draft_post is a thin persist tool:
 * the agent drafts + validates the body in its own LLM turns and hands
 * the final string to this tool, which verifies ownership / kind /
 * channel and writes the row. Tests cover the happy path (writes
 * draft_body + channel, transitions to 'drafted', merges prior output
 * keys), guard rails (ownership, kind, channel), and schema validation.
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

import { draftPostTool } from '../DraftPostTool';
import { planItems } from '@/lib/db/schema';

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
  it('persists the draft body, returns channel, transitions to drafted', async () => {
    const { planItemId } = seedHappyPath(store);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const draftBody = 'Week 1 of building the planner: 4 skills deleted, 2 agents shipped. #buildinpublic';
    const result = await draftPostTool.execute(
      { planItemId, draftBody },
      ctx,
    );

    expect(result.planItemId).toBe(planItemId);
    expect(result.channel).toBe('x');
    expect(result.draft_body).toBe(draftBody);

    const rows = store.get<PlanItemRow>(planItems);
    expect(rows).toHaveLength(1);
    const updated = rows[0]!;
    expect(updated.state).toBe('drafted');
    const output = updated.output as Record<string, unknown>;
    expect(output.draft_body).toBe(draftBody);
    expect(output.channel).toBe('x');
  });

  it('persists the optional whyItWorks rationale onto the row', async () => {
    const { planItemId } = seedHappyPath(store);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    await draftPostTool.execute(
      {
        planItemId,
        draftBody: 'short tweet body',
        whyItWorks: 'metric-anchored hook lands week-1 thesis',
      },
      ctx,
    );

    const output = store.get<PlanItemRow>(planItems)[0]!
      .output as Record<string, unknown>;
    expect(output.whyItWorks).toBe(
      'metric-anchored hook lands week-1 thesis',
    );
  });

  it('reads channel from the plan_item row (caller cannot override)', async () => {
    const { planItemId } = seedHappyPath(store);
    // Flip channel on the seeded row.
    store.get<PlanItemRow>(planItems)[0]!.channel = 'reddit';
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const result = await draftPostTool.execute(
      { planItemId, draftBody: 'a long-form reddit post body' },
      ctx,
    );
    expect(result.channel).toBe('reddit');
  });

  it('rejects a plan_item owned by a different user+product', async () => {
    const { planItemId } = seedHappyPath(store);
    const ctx = makeCtx(store, {
      userId: 'other-user',
      productId: 'prod-1',
    });

    await expect(
      draftPostTool.execute({ planItemId, draftBody: 'whatever' }, ctx),
    ).rejects.toThrow(/not owned by the current/);
    // Row should stay 'planned' (no update fired).
    expect(store.get<PlanItemRow>(planItems)[0]!.state).toBe('planned');
  });

  it('rejects when the plan_item kind is not content_post', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.kind = 'setup_task';
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(
      draftPostTool.execute({ planItemId, draftBody: 'x' }, ctx),
    ).rejects.toThrow(/expected "content_post"/);
  });

  it('rejects when the plan_item has no channel', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.channel = null;
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(
      draftPostTool.execute({ planItemId, draftBody: 'x' }, ctx),
    ).rejects.toThrow(/no channel set/);
  });

  it('rejects when the plan_item does not exist', async () => {
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    await expect(
      draftPostTool.execute(
        { planItemId: 'missing-item', draftBody: 'x' },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
  });

  it('rejects invalid input via the schema (empty body)', () => {
    const parse = draftPostTool.inputSchema.safeParse({
      planItemId: 'p',
      draftBody: '',
    });
    expect(parse.success).toBe(false);
  });

  it('rejects invalid input via the schema (missing planItemId)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { draftBody: 'hi' } as any;
    const parse = draftPostTool.inputSchema.safeParse(bad);
    expect(parse.success).toBe(false);
  });

  it('rejects unknown keys via strict schema', () => {
    const parse = draftPostTool.inputSchema.safeParse({
      planItemId: 'p',
      draftBody: 'x',
      // unknown key — strict() rejects rather than silently dropping; the
      // agent should never pass random keys here.
      channel: 'x',
    });
    expect(parse.success).toBe(false);
  });

  it('preserves prior output keys on subsequent drafts', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.output = {
      confidence: 0.7,
      whyItWorks: 'grounded in metric',
    };
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    await draftPostTool.execute(
      { planItemId, draftBody: 'Redraft — cleaner hook, still grounded in metric.' },
      ctx,
    );

    const updated = store.get<PlanItemRow>(planItems)[0]!
      .output as Record<string, unknown>;
    expect(updated.confidence).toBe(0.7);
    expect(updated.whyItWorks).toBe('grounded in metric');
    expect(updated.draft_body).toContain('Redraft');
  });

  it('overwrites whyItWorks when the caller passes a fresh value', async () => {
    const { planItemId } = seedHappyPath(store);
    store.get<PlanItemRow>(planItems)[0]!.output = {
      whyItWorks: 'old rationale',
    };
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    await draftPostTool.execute(
      {
        planItemId,
        draftBody: 'new body',
        whyItWorks: 'new rationale — sharper hook',
      },
      ctx,
    );

    const updated = store.get<PlanItemRow>(planItems)[0]!
      .output as Record<string, unknown>;
    expect(updated.whyItWorks).toBe('new rationale — sharper hook');
  });
});
