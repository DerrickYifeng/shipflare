/**
 * Unit tests for synthesizeContentPostDraft.
 *
 * Uses the in-memory DB store so no real Postgres is needed.
 * The helper performs two inserts: threads first, then drafts referencing
 * the new thread id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// ----------------------------------------------------------------
// Import AFTER mocks are set up so the module picks up the mocked db.
// ----------------------------------------------------------------
import { synthesizeContentPostDraft } from '../synthesize-content-post-draft';
import { threads, drafts, planItems } from '@/lib/db/schema';
import type { OwnedRow } from '@/app/api/plan-item/[id]/_helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal OwnedRow for a content_post on platform X. */
function makeXPlanRow(id = 'plan-1'): OwnedRow {
  return {
    id,
    userId: 'user-1',
    state: 'approved',
    userAction: 'approve',
    kind: 'content_post',
    channel: 'x',
    skillName: null,
  };
}

/** Minimal OwnedRow for a content_post on Reddit. */
function makeRedditPlanRow(id = 'plan-r1'): OwnedRow {
  return {
    id,
    userId: 'user-1',
    state: 'approved',
    userAction: 'approve',
    kind: 'content_post',
    channel: 'reddit',
    skillName: null,
  };
}

interface PlanItemSeedRow {
  id: string;
  userId: string;
  productId: string;
  planId: string;
  kind: string;
  state: string;
  userAction: string;
  phase: string;
  channel: string | null;
  dueDate: Date;
  sortOrder: number;
  skillName: string | null;
  params: unknown;
  output: unknown;
  title: string;
  description: string | null;
}

function seedPlanItem(
  store: InMemoryStore,
  overrides: Partial<PlanItemSeedRow> & { id: string },
) {
  store.register<PlanItemSeedRow>(planItems, [
    {
      userId: 'user-1',
      productId: 'prod-1',
      planId: 'plan-plan-1',
      kind: 'content_post',
      state: 'approved',
      userAction: 'approve',
      phase: 'foundation',
      channel: 'x',
      dueDate: new Date('2026-05-11'),
      sortOrder: 0,
      skillName: null,
      params: {},
      output: null,
      title: 'My original post title',
      description: null,
      ...overrides,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Swap the db singleton the module captured at import time.
// ---------------------------------------------------------------------------

let store: InMemoryStore;

beforeEach(async () => {
  store = createInMemoryStore();

  // Re-point @/lib/db to the fresh store.
  const dbModule = await import('@/lib/db');
  (dbModule as { db: unknown }).db = store.db;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synthesizeContentPostDraft — happy path (X)', () => {
  it('inserts a threads row and a drafts row, returns draftId', async () => {
    seedPlanItem(store, {
      id: 'plan-1',
      channel: 'x',
      output: {
        draft_body: 'hello world',
        whyItWorks: 'catchy hook',
        confidence_score: 0.85,
      },
      title: 'My post',
    });

    const result = await synthesizeContentPostDraft(
      makeXPlanRow('plan-1'),
      'user-1',
    );

    expect(result).not.toBeNull();
    expect(result?.draftId).toBeTruthy();

    // Threads row
    const threadRows = store.get<Record<string, unknown>>(threads);
    expect(threadRows).toHaveLength(1);
    const thread = threadRows[0]!;
    expect(thread.platform).toBe('x');
    expect(thread.externalId).toBe('content-post:plan-1');
    expect(thread.userId).toBe('user-1');
    expect(thread.body).toBe('hello world');

    // Drafts row
    const draftRows = store.get<Record<string, unknown>>(drafts);
    expect(draftRows).toHaveLength(1);
    const draft = draftRows[0]!;
    expect(draft.replyBody).toBe('hello world');
    expect(draft.draftType).toBe('original_post');
    expect(draft.userId).toBe('user-1');
    expect(draft.planItemId).toBe('plan-1');
    expect(draft.status).toBe('pending');
    expect(draft.confidenceScore).toBe(0.85);
    expect(draft.whyItWorks).toBe('catchy hook');
    // X posts have no postTitle
    expect(draft.postTitle == null || draft.postTitle === undefined).toBe(true);

    // threadId links the two rows
    expect(draft.threadId).toBe(thread.id);

    // Returned draftId matches inserted row
    expect(result!.draftId).toBe(draft.id);
  });

  it('defaults confidenceScore to 0 when absent from output', async () => {
    seedPlanItem(store, {
      id: 'plan-1',
      channel: 'x',
      output: { draft_body: 'just a body' },
    });

    await synthesizeContentPostDraft(makeXPlanRow('plan-1'), 'user-1');

    const draftRows = store.get<Record<string, unknown>>(drafts);
    expect(draftRows[0]?.confidenceScore).toBe(0);
  });
});

describe('synthesizeContentPostDraft — happy path (Reddit)', () => {
  it('sets subreddit and postTitle from params/output', async () => {
    seedPlanItem(store, {
      id: 'plan-r1',
      channel: 'reddit',
      params: { subreddit: 'r/indiehackers' },
      output: {
        draft_body: 'reddit post body',
        post_title: 'My Reddit Post',
      },
      title: 'Fallback title',
    });

    const result = await synthesizeContentPostDraft(
      makeRedditPlanRow('plan-r1'),
      'user-1',
    );
    expect(result).not.toBeNull();

    const threadRows = store.get<Record<string, unknown>>(threads);
    expect(threadRows[0]?.community).toBe('indiehackers');

    const draftRows = store.get<Record<string, unknown>>(drafts);
    expect(draftRows[0]?.postTitle).toBe('My Reddit Post');
  });

  it('strips r/ prefix from subreddit', async () => {
    seedPlanItem(store, {
      id: 'plan-r2',
      channel: 'reddit',
      params: { subreddit: 'r/SaaS' },
      output: { draft_body: 'body' },
      title: 'Plan title',
    });

    await synthesizeContentPostDraft(makeRedditPlanRow('plan-r2'), 'user-1');

    const threadRows = store.get<Record<string, unknown>>(threads);
    expect(threadRows[0]?.community).toBe('SaaS');
  });

  it('falls back to plan_item title when output.post_title is absent', async () => {
    seedPlanItem(store, {
      id: 'plan-r3',
      channel: 'reddit',
      params: { subreddit: 'indiehackers' },
      output: { draft_body: 'body without title' },
      title: 'Use this as title',
    });

    await synthesizeContentPostDraft(makeRedditPlanRow('plan-r3'), 'user-1');

    const draftRows = store.get<Record<string, unknown>>(drafts);
    expect(draftRows[0]?.postTitle).toBe('Use this as title');
  });
});

describe('synthesizeContentPostDraft — null cases', () => {
  it('returns null when output is null', async () => {
    seedPlanItem(store, { id: 'plan-1', channel: 'x', output: null });

    const result = await synthesizeContentPostDraft(
      makeXPlanRow('plan-1'),
      'user-1',
    );
    expect(result).toBeNull();
    expect(store.get(threads)).toHaveLength(0);
    expect(store.get(drafts)).toHaveLength(0);
  });

  it('returns null when output.draft_body is missing', async () => {
    seedPlanItem(store, {
      id: 'plan-1',
      channel: 'x',
      output: { whyItWorks: 'no body yet' },
    });

    const result = await synthesizeContentPostDraft(
      makeXPlanRow('plan-1'),
      'user-1',
    );
    expect(result).toBeNull();
    expect(store.get(threads)).toHaveLength(0);
    expect(store.get(drafts)).toHaveLength(0);
  });

  it('returns null when output.draft_body is empty string', async () => {
    seedPlanItem(store, {
      id: 'plan-1',
      channel: 'x',
      output: { draft_body: '' },
    });

    const result = await synthesizeContentPostDraft(
      makeXPlanRow('plan-1'),
      'user-1',
    );
    expect(result).toBeNull();
    expect(store.get(threads)).toHaveLength(0);
    expect(store.get(drafts)).toHaveLength(0);
  });

  it('returns null when planRow kind is not content_post', async () => {
    const nonPostRow: OwnedRow = {
      ...makeXPlanRow('plan-1'),
      kind: 'setup_task',
    };
    seedPlanItem(store, {
      id: 'plan-1',
      channel: 'x',
      output: { draft_body: 'some body' },
    });

    const result = await synthesizeContentPostDraft(nonPostRow, 'user-1');
    expect(result).toBeNull();
    expect(store.get(threads)).toHaveLength(0);
  });

  it('returns null when planRow.channel is null', async () => {
    const noChannelRow: OwnedRow = {
      ...makeXPlanRow('plan-1'),
      channel: null,
    };
    seedPlanItem(store, {
      id: 'plan-1',
      channel: null,
      output: { draft_body: 'some body' },
    });

    const result = await synthesizeContentPostDraft(noChannelRow, 'user-1');
    expect(result).toBeNull();
    expect(store.get(threads)).toHaveLength(0);
  });

  it('returns null when no plan_item row found in DB', async () => {
    // Don't seed any plan_item rows.
    const result = await synthesizeContentPostDraft(
      makeXPlanRow('plan-missing'),
      'user-1',
    );
    expect(result).toBeNull();
    expect(store.get(threads)).toHaveLength(0);
  });
});
