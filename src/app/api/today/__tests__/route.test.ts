import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// Captured from the route: pending = items list query, stats = aggregate.
let pendingRows: Array<{
  id: string;
  kind: string;
  state: string;
  channel: string | null;
  scheduledAt: Date;
  title: string;
  description: string | null;
  createdAt: Date;
}> = [];
let statsRow: {
  publishedYesterday: number;
  actedToday: number;
  pendingCount: number;
  anyItems: number;
} = {
  publishedYesterday: 0,
  actedToday: 0,
  pendingCount: 0,
  anyItems: 0,
};

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isStats = fields.includes('anyItems');
      return {
        from: () => ({
          where: () => {
            if (isStats) {
              // aggregate has no orderBy — caller awaits the thenable directly
              return Promise.resolve([statsRow]);
            }
            // pending list has orderBy after where
            return {
              orderBy: () => Promise.resolve(pendingRows),
            };
          },
        }),
      };
    },
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    gte: () => ({}),
    lt: () => ({}),
    inArray: () => ({}),
    sql: Object.assign(
      (..._args: unknown[]) => ({ mapWith: () => ({}) }),
      { raw: () => ({}) },
    ),
  };
});

beforeEach(() => {
  authUserId = 'user-1';
  pendingRows = [];
  statsRow = {
    publishedYesterday: 0,
    actedToday: 0,
    pendingCount: 0,
    anyItems: 0,
  };
});

describe('GET /api/today', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns an empty feed with hasAnyPlanItems=false when no plan_items exist', async () => {
    pendingRows = [];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      pendingCount: 0,
      anyItems: 0,
    };
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      hasAnyPlanItems: boolean;
      stats: { pending_count: number };
    };
    expect(body.items).toEqual([]);
    expect(body.hasAnyPlanItems).toBe(false);
    expect(body.stats.pending_count).toBe(0);
  });

  it('projects pending plan_items into TodoItem-shaped rows', async () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86_400_000 + 3_600_000);
    pendingRows = [
      {
        id: 'pi-1',
        kind: 'content_post',
        state: 'planned',
        channel: 'x',
        scheduledAt: tomorrow,
        title: 'Ship post A',
        description: null,
        createdAt: now,
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      pendingCount: 1,
      anyItems: 1,
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        todoType: string;
        source: string;
        priority: string;
        platform: string;
        calendarContentType: string;
      }>;
      hasAnyPlanItems: boolean;
    };
    expect(body.hasAnyPlanItems).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('pi-1');
    expect(body.items[0].todoType).toBe('approve_post');
    expect(body.items[0].source).toBe('calendar');
    expect(body.items[0].priority).toBe('scheduled');
    expect(body.items[0].platform).toBe('x');
    expect(body.items[0].calendarContentType).toBe('content_post');
  });

  it('marks items scheduled within today as time_sensitive', async () => {
    const now = new Date();
    pendingRows = [
      {
        id: 'pi-1',
        kind: 'content_post',
        state: 'ready_for_review',
        channel: 'x',
        scheduledAt: now,
        title: 'Post today',
        description: null,
        createdAt: now,
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      pendingCount: 1,
      anyItems: 1,
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{ priority: string }>;
    };
    expect(body.items[0].priority).toBe('time_sensitive');
  });

  it('sets hasAnyPlanItems=true even when all items are terminal', async () => {
    pendingRows = [];
    statsRow = {
      publishedYesterday: 2,
      actedToday: 1,
      pendingCount: 0,
      anyItems: 5,
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: unknown[];
      hasAnyPlanItems: boolean;
      stats: { published_yesterday: number; acted_today: number };
    };
    expect(body.items).toEqual([]);
    expect(body.hasAnyPlanItems).toBe(true);
    expect(body.stats.published_yesterday).toBe(2);
    expect(body.stats.acted_today).toBe(1);
  });
});
