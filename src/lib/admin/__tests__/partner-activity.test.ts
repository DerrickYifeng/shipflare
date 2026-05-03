import { describe, it, expect, vi, beforeEach } from 'vitest';

// The implementation issues 3 SELECTs in fixed order via Promise.all:
//   1. posts (innerJoin drafts) — original_post
//   2. posts (innerJoin drafts) — reply
//   3. pipelineEvents — discovered
//
// We mock by call-index: nthSelect[i] returns the rows for query i.
// Promise.all preserves index ordering of inputs, so this is deterministic.
type Row = { userId: string; count: number };
let queue: Row[][] = [];
let callIndex = 0;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => makeChain(),
    }),
  },
}));

function makeChain() {
  // Both query shapes end with .groupBy(); the rowset comes from the queue.
  const resolveNext = (): Promise<Row[]> => {
    const rows = queue[callIndex] ?? [];
    callIndex += 1;
    return Promise.resolve(rows);
  };
  return {
    innerJoin: () => ({
      where: () => ({ groupBy: resolveNext }),
    }),
    where: () => ({ groupBy: resolveNext }),
  };
}

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    gte: () => ({}),
    inArray: () => ({}),
    sql: Object.assign(
      (..._args: unknown[]) => ({ as: () => ({}) }),
      { raw: () => ({}) },
    ),
  };
});

vi.mock('@/lib/db/schema', () => ({
  posts: { userId: 'p_user', draftId: 'p_draft', postedAt: 'p_at' },
  drafts: { id: 'd_id', draftType: 'd_type' },
  pipelineEvents: { userId: 'pe_user', enteredAt: 'pe_at', stage: 'pe_stage' },
}));

const { getPartnerActivityCounts } = await import('../partner-activity');

beforeEach(() => {
  queue = [];
  callIndex = 0;
});

describe('getPartnerActivityCounts', () => {
  it('returns empty map and skips queries when userIds is empty', async () => {
    const result = await getPartnerActivityCounts([]);
    expect(result.size).toBe(0);
    expect(callIndex).toBe(0); // never queried
  });

  it('zero-fills users with no activity', async () => {
    queue = [[], [], []];
    const result = await getPartnerActivityCounts(['u1', 'u2']);
    expect(result.get('u1')).toEqual({ posts7d: 0, replies7d: 0, scans7d: 0 });
    expect(result.get('u2')).toEqual({ posts7d: 0, replies7d: 0, scans7d: 0 });
  });

  it('rolls up posts, replies, and scans into the per-user shape', async () => {
    queue = [
      // 1) original posts
      [{ userId: 'u1', count: 4 }],
      // 2) replies
      [
        { userId: 'u1', count: 2 },
        { userId: 'u2', count: 5 },
      ],
      // 3) scans
      [{ userId: 'u2', count: 12 }],
    ];
    const result = await getPartnerActivityCounts(['u1', 'u2', 'u3']);
    expect(result.get('u1')).toEqual({ posts7d: 4, replies7d: 2, scans7d: 0 });
    expect(result.get('u2')).toEqual({ posts7d: 0, replies7d: 5, scans7d: 12 });
    expect(result.get('u3')).toEqual({ posts7d: 0, replies7d: 0, scans7d: 0 });
  });

  it('coerces string counts (postgres int driver may return strings)', async () => {
    queue = [
      // count returned as string-typed value
      [{ userId: 'u1', count: '7' as unknown as number }],
      [],
      [],
    ];
    const result = await getPartnerActivityCounts(['u1']);
    expect(result.get('u1')).toEqual({ posts7d: 7, replies7d: 0, scans7d: 0 });
  });
});
