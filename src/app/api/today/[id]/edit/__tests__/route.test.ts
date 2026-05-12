import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const findOwnedPlanItemMock = vi.fn();
vi.mock('@/app/api/plan-item/[id]/_helpers', () => ({
  findOwnedPlanItem: (id: string, userId: string) =>
    findOwnedPlanItemMock(id, userId),
  paramsSchema: {
    safeParse: (v: { id: string }) => ({
      success: /^[0-9a-f-]{36}$/.test(v.id),
      data: v,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 't',
  }),
}));

// The route reads drafts when the plan_item lookup misses, then issues
// either an UPDATE planItems (jsonb_set on output.draft_body, or
// params merge) or an UPDATE drafts (replyBody). We capture every
// update so tests can assert which path(s) ran without poking at SQL.
const draftLookupMock = vi.fn();
interface UpdateRecord {
  table: string;
  set: Record<string, unknown>;
}
const updates: UpdateRecord[] = [];
// Convenience accessor preserved for existing tests that read the
// last-write table/set. New tests can iterate `updates` directly to
// see both the body-update AND the params-merge from the same PATCH.
const lastUpdate: { table: string | null; set: Record<string, unknown> | null } = {
  table: null,
  set: null,
};

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => draftLookupMock(),
        }),
      }),
    }),
    update: (table: { _: { name?: string } } & { name?: string } | string) => ({
      set: (s: Record<string, unknown>) => ({
        where: () => {
          // drizzle pgTable identity carries `Symbol(drizzle:Name)`; the
          // schema mock below stamps a `__name` so we can assert which
          // table was hit.
          const id = (table as unknown as { __name?: string }).__name ?? 'unknown';
          updates.push({ table: id, set: s });
          lastUpdate.table = id;
          lastUpdate.set = s;
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  drafts: { __name: 'drafts', id: 'id', userId: 'userId', replyBody: 'replyBody', status: 'status', updatedAt: 'updatedAt' },
  planItems: {
    __name: 'planItems',
    id: 'id',
    userId: 'userId',
    output: 'output',
    params: 'params',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conds: unknown[]) => ({ conds }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    'http://localhost/api/today/11111111-1111-1111-1111-111111111111/edit',
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

const VALID_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  authUserId = 'user-1';
  findOwnedPlanItemMock.mockReset();
  draftLookupMock.mockReset();
  updates.length = 0;
  lastUpdate.table = null;
  lastUpdate.set = null;
});

describe('PATCH /api/today/[id]/edit', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'hello' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid uuid', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'hello' }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({}), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is empty / whitespace-only', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: '   \n  ' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when neither plan_item nor draft is owned', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'hello' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('updates plan_items.output.draft_body when id resolves to a plan_item in drafted state', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'x',
      skillName: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'fresh draft text' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(lastUpdate.table).toBe('planItems');
    expect(lastUpdate.set?.output).toBeTruthy();
  });

  it('updates plan_items in ready_for_review state too', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'ready_for_review',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'x',
      skillName: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'edited' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(lastUpdate.table).toBe('planItems');
  });

  it('rejects edit on plan_items already approved/posted with 409', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'approved',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'x',
      skillName: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'too late' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
    expect(lastUpdate.table).toBeNull();
  });

  it('updates drafts.replyBody when id resolves to a pending draft', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([
      { id: VALID_ID, userId: 'user-1', status: 'pending' },
    ]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'reworded reply' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(lastUpdate.table).toBe('drafts');
    expect(lastUpdate.set?.replyBody).toBe('reworded reply');
  });

  it('rejects edit on a draft already approved/handed_off with 409', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([
      { id: VALID_ID, userId: 'user-1', status: 'handed_off' },
    ]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ body: 'too late' }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
    expect(lastUpdate.table).toBeNull();
  });
});

// ── params patches (Reddit subreddit picker safety net) ────────────────
//
// Locks in the new shape:
//   PATCH { params: { subreddit: 'SaaS' } } → merges into plan_items.params
// without dropping unrelated keys, and still respects the existing
// EDITABLE_PLAN_STATES gate. Adversarial shapes (`r/SaaS`, missing
// subreddit, both body+params, neither) must be rejected as 400 / honored
// in the documented order.

describe('PATCH /api/today/[id]/edit — params patches', () => {
  it('rejects an empty patch with 400 (refine: at least one of body/params)', async () => {
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({}), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
    expect(updates.length).toBe(0);
  });

  it('accepts a valid subreddit params patch and merges into existing params', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: { targetCount: 1, templateId: 'orig-1' },
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ params: { subreddit: 'SaaS' } }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    // Exactly one update — the params merge. Body wasn't patched.
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('planItems');
    expect(updates[0].set.params).toEqual({
      targetCount: 1,
      templateId: 'orig-1',
      subreddit: 'SaaS',
    });
  });

  it('preserves params merge when the existing params object is null', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ params: { subreddit: 'webdev' } }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].set.params).toEqual({ subreddit: 'webdev' });
  });

  it('rejects subreddit values with `r/` prefix or other regex misses', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ params: { subreddit: 'r/SaaS' } }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
    expect(updates.length).toBe(0);
  });

  it('rejects subreddit values that are too short', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ params: { subreddit: 'ab' } }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
    expect(updates.length).toBe(0);
  });

  it('rejects unknown keys in params (strict schema)', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makeReq({ params: { subreddit: 'SaaS', evilFlag: true } }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(res.status).toBe(400);
    expect(updates.length).toBe(0);
  });

  it('updates both body AND params in one PATCH', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'drafted',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: { targetCount: 1 },
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(
      makeReq({ body: 'new body', params: { subreddit: 'SaaS' } }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    expect(res.status).toBe(200);
    // Two updates: body first, then params merge.
    expect(updates).toHaveLength(2);
    expect(updates[0].table).toBe('planItems');
    expect(updates[0].set.output).toBeTruthy();
    expect(updates[1].table).toBe('planItems');
    expect(updates[1].set.params).toEqual({ targetCount: 1, subreddit: 'SaaS' });
  });

  it('respects the same not_editable state gate for params patches', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce({
      id: VALID_ID,
      userId: 'user-1',
      state: 'approved',
      userAction: 'approve',
      kind: 'content_post',
      channel: 'reddit',
      skillName: null,
      params: null,
    });
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ params: { subreddit: 'SaaS' } }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
    expect(updates.length).toBe(0);
  });

  it('rejects params patches that fall through to the drafts path with 400', async () => {
    findOwnedPlanItemMock.mockResolvedValueOnce(null);
    draftLookupMock.mockResolvedValueOnce([
      { id: VALID_ID, userId: 'user-1', status: 'pending' },
    ]);
    const { PATCH } = await import('../route');
    const res = await PATCH(makeReq({ params: { subreddit: 'SaaS' } }), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(400);
    expect(updates.length).toBe(0);
  });
});
