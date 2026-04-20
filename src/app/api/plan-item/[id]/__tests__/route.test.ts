import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { PlanItemState, PlanItemUserAction } from '@/lib/plan-state';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

const enqueuePlanExecuteMock = vi.fn(async () => 'job-id');
vi.mock('@/lib/queue', () => ({
  enqueuePlanExecute: enqueuePlanExecuteMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  loggerForRequest: () => ({
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    traceId: 'trace-test',
  }),
}));

// In-memory plan_items fixture. Matches what the helpers select.
interface Row {
  id: string;
  userId: string;
  state: PlanItemState;
  userAction: PlanItemUserAction;
  kind: string;
  channel: string | null;
  skillName: string | null;
}

const rows = new Map<string, Row>();

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { __values?: string[] }) => ({
          limit: () => {
            // The helper passes an and(eq(id), eq(userId)) condition;
            // our drizzle-orm mock collapses the values into __values
            // in positional order: [itemId, userId].
            const vals = cond.__values ?? [];
            const [itemId, userId] = vals;
            if (!itemId || !userId) return [];
            const row = rows.get(itemId);
            if (!row) return [];
            if (row.userId !== userId) return [];
            return [row];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: async (cond: { __values?: string[] }) => {
          // writePlanItemState uses eq(planItems.id, row.id) alone (no
          // and()) — our eq() mock sets __values to [id].
          const vals = cond.__values ?? [];
          const id = vals[0];
          if (!id) return [];
          const row = rows.get(id);
          if (!row) return [];
          rows.set(id, { ...row, ...patch });
          return [{ id }];
        },
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    // Each eq() sentinel carries a __values array with one entry. and()
    // concatenates them in positional order so the helpers' patterns
    // (and(eq(id,x), eq(userId,y)) or eq(id,x) solo) both surface as
    // __values on the final where() argument.
    eq: (_col: unknown, value: unknown) => ({
      __values: [value as string],
    }),
    and: (...conds: Array<{ __values?: string[] }>) => ({
      __values: conds.flatMap((c) => c.__values ?? []),
    }),
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
  };
});

const VALID_ID = '11111111-2222-3333-4444-555555555555';

function seed(init: Partial<Row> & { id?: string } = {}): Row {
  const row: Row = {
    id: init.id ?? VALID_ID,
    userId: 'user-1',
    state: 'ready_for_review',
    userAction: 'approve',
    kind: 'content_post',
    channel: 'x',
    skillName: 'draft-single-post',
    ...init,
  };
  rows.set(row.id, row);
  return row;
}

function makeReq(path: string, method: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method });
}

beforeEach(() => {
  authUserId = 'user-1';
  rows.clear();
  enqueuePlanExecuteMock.mockClear();
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe('POST /api/plan-item/[id]/approve', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { POST } = await import('../approve/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/approve`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid uuid', async () => {
    const { POST } = await import('../approve/route');
    const res = await POST(makeReq(`/api/plan-item/not-a-uuid/approve`, 'POST'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when item not owned by caller', async () => {
    seed({ userId: 'different-user' });
    const { POST } = await import('../approve/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/approve`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('transitions ready_for_review → approved and enqueues execute', async () => {
    seed({ state: 'ready_for_review' });
    const { POST } = await import('../approve/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/approve`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(rows.get(VALID_ID)!.state).toBe('approved');
    expect(enqueuePlanExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        planItemId: VALID_ID,
        phase: 'execute',
        userId: 'user-1',
      }),
    );
  });

  it('rejects approval from a non-ready_for_review state (409)', async () => {
    seed({ state: 'planned' });
    const { POST } = await import('../approve/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/approve`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('invalid_transition');
    expect(enqueuePlanExecuteMock).not.toHaveBeenCalled();
  });

  it('rejects approval from a terminal state', async () => {
    seed({ state: 'completed' });
    const { POST } = await import('../approve/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/approve`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// skip
// ---------------------------------------------------------------------------

describe('POST /api/plan-item/[id]/skip', () => {
  it('skips from planned', async () => {
    seed({ state: 'planned' });
    const { POST } = await import('../skip/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/skip`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(rows.get(VALID_ID)!.state).toBe('skipped');
  });

  it('skips from drafted', async () => {
    seed({ state: 'drafted' });
    const { POST } = await import('../skip/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/skip`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(rows.get(VALID_ID)!.state).toBe('skipped');
  });

  it('skips from ready_for_review', async () => {
    seed({ state: 'ready_for_review' });
    const { POST } = await import('../skip/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/skip`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(rows.get(VALID_ID)!.state).toBe('skipped');
  });

  it('skips from approved (user changes their mind)', async () => {
    seed({ state: 'approved' });
    const { POST } = await import('../skip/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/skip`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(rows.get(VALID_ID)!.state).toBe('skipped');
  });

  it('rejects skip from executing (409)', async () => {
    seed({ state: 'executing' });
    const { POST } = await import('../skip/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/skip`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects skip from a terminal state (409)', async () => {
    seed({ state: 'completed' });
    const { POST } = await import('../skip/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/skip`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

describe('POST /api/plan-item/[id]/complete', () => {
  it('completes a manual planned item', async () => {
    seed({ state: 'planned', userAction: 'manual', kind: 'interview' });
    const { POST } = await import('../complete/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/complete`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(200);
    expect(rows.get(VALID_ID)!.state).toBe('completed');
  });

  it('rejects complete when userAction is approve (403 not_manual)', async () => {
    seed({ state: 'planned', userAction: 'approve' });
    const { POST } = await import('../complete/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/complete`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe('not_manual');
  });

  it('rejects complete when userAction is auto (403)', async () => {
    seed({ state: 'planned', userAction: 'auto' });
    const { POST } = await import('../complete/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/complete`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects complete from a non-planned state for manual items (409)', async () => {
    seed({ state: 'drafted', userAction: 'manual' });
    const { POST } = await import('../complete/route');
    const res = await POST(makeReq(`/api/plan-item/${VALID_ID}/complete`, 'POST'), {
      params: Promise.resolve({ id: VALID_ID }),
    });
    // drafted is not a manual-transition source; planned → completed is
    // the SM-allowed move. The SM should reject drafted → completed.
    expect(res.status).toBe(409);
  });
});
