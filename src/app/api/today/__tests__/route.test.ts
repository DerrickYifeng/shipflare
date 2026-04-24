import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// Three query paths fan out from GET:
//   (a) pending plan_items list  — fields include `output` (no `anyItems`)
//   (b) pending drafts ⨯ threads — fields include `replyBody`
//   (c) stats aggregate           — fields include `anyItems`
// The mock dispatches on field presence so the route-level order doesn't
// couple the test to the implementation's call sequence.
type PlanRow = {
  id: string;
  kind: string;
  state: string;
  channel: string | null;
  scheduledAt: Date;
  title: string;
  description: string | null;
  createdAt: Date;
  output: Record<string, unknown> | null;
};
type DraftJoinRow = {
  draftId: string;
  draftStatus: string;
  draftType: 'reply' | 'original_post';
  postTitle: string | null;
  replyBody: string;
  confidenceScore: number;
  whyItWorks: string | null;
  media: unknown;
  draftCreatedAt: Date;
  threadId: string;
  threadPlatform: string;
  threadCommunity: string;
  threadTitle: string;
  threadBody: string | null;
  threadAuthor: string | null;
  threadUrl: string;
  threadUpvotes: number | null;
  threadCommentCount: number | null;
  threadPostedAt: Date | null;
  threadDiscoveredAt: Date;
};
type StatsRow = {
  publishedYesterday: number;
  actedToday: number;
  planPending: number;
  anyItems: number;
};

let planRows: PlanRow[] = [];
let draftRows: DraftJoinRow[] = [];
let statsRow: StatsRow = {
  publishedYesterday: 0,
  actedToday: 0,
  planPending: 0,
  anyItems: 0,
};

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isStats = fields.includes('anyItems');
      const isDrafts = fields.includes('replyBody');

      // Stats aggregate: `.from(...).where(...)` — awaited directly.
      if (isStats) {
        return {
          from: () => ({ where: () => Promise.resolve([statsRow]) }),
        };
      }

      // Drafts ⨯ threads: `.from(...).innerJoin(...).where(...).orderBy(...)`.
      if (isDrafts) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                orderBy: () => Promise.resolve(draftRows),
              }),
            }),
          }),
        };
      }

      // Pending plan_items: `.from(...).where(...).orderBy(...)`.
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(planRows),
          }),
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
    desc: (x: unknown) => x,
    sql: Object.assign(
      (..._args: unknown[]) => ({ mapWith: () => ({}) }),
      { raw: () => ({}) },
    ),
  };
});

beforeEach(() => {
  authUserId = 'user-1';
  planRows = [];
  draftRows = [];
  statsRow = {
    publishedYesterday: 0,
    actedToday: 0,
    planPending: 0,
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

  it('returns an empty feed with hasAnyPlanItems=false when no rows exist', async () => {
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
    planRows = [
      {
        id: 'pi-1',
        kind: 'content_post',
        state: 'drafted',
        channel: 'x',
        scheduledAt: tomorrow,
        title: 'Ship post A',
        description: null,
        createdAt: now,
        output: { draft_body: 'Hello world — drafted by x-writer', channel: 'x' },
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      planPending: 1,
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
        draftBody: string | null;
        draftType: string | null;
      }>;
      hasAnyPlanItems: boolean;
      stats: { pending_count: number };
    };
    expect(body.hasAnyPlanItems).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('pi-1');
    expect(body.items[0].todoType).toBe('approve_post');
    expect(body.items[0].source).toBe('calendar');
    expect(body.items[0].priority).toBe('scheduled');
    expect(body.items[0].platform).toBe('x');
    expect(body.items[0].calendarContentType).toBe('content_post');
    // The core regression: draft_body must surface from plan_items.output.
    expect(body.items[0].draftBody).toBe('Hello world — drafted by x-writer');
    expect(body.items[0].draftType).toBe('original_post');
    expect(body.stats.pending_count).toBe(1);
  });

  it('falls back to null draftBody when plan_items.output has no draft_body', async () => {
    const now = new Date();
    planRows = [
      {
        id: 'pi-2',
        kind: 'content_post',
        state: 'drafted',
        channel: 'x',
        scheduledAt: now,
        title: 'Missing body',
        description: null,
        createdAt: now,
        output: null,
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      planPending: 1,
      anyItems: 1,
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{ draftBody: string | null; draftType: string | null }>;
    };
    expect(body.items[0].draftBody).toBeNull();
    // No body → no draftType (card renders "drafting…" fallback in the UI).
    expect(body.items[0].draftType).toBeNull();
  });

  it('marks items scheduled within today as time_sensitive', async () => {
    const now = new Date();
    planRows = [
      {
        id: 'pi-1',
        kind: 'content_post',
        state: 'ready_for_review',
        channel: 'x',
        scheduledAt: now,
        title: 'Post today',
        description: null,
        createdAt: now,
        output: { draft_body: 'today body' },
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      planPending: 1,
      anyItems: 1,
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{ priority: string }>;
    };
    expect(body.items[0].priority).toBe('time_sensitive');
  });

  it('projects pending reply drafts joined with threads into reply_thread rows', async () => {
    const now = new Date();
    const discoveredAt = new Date(now.getTime() - 30 * 60_000);
    const postedAt = new Date(now.getTime() - 2 * 60 * 60_000);
    draftRows = [
      {
        draftId: 'd-1',
        draftStatus: 'pending',
        draftType: 'reply',
        postTitle: null,
        replyBody: 'Thanks for flagging — here is how we think about it.',
        confidenceScore: 0.82,
        whyItWorks: 'Direct answer, no pitch',
        media: null,
        draftCreatedAt: now,
        threadId: 't-1',
        threadPlatform: 'x',
        threadCommunity: 'timeline',
        threadTitle: 'Anyone know a good reply tool?',
        threadBody: 'Trying to reply to every thread is a grind.',
        threadAuthor: '@founder',
        threadUrl: 'https://x.com/example/status/123',
        threadUpvotes: 14,
        threadCommentCount: 3,
        threadPostedAt: postedAt,
        threadDiscoveredAt: discoveredAt,
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      planPending: 0,
      anyItems: 0, // no plan items, only a draft
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        draftId: string | null;
        todoType: string;
        source: string;
        platform: string;
        community: string | null;
        externalUrl: string | null;
        draftBody: string | null;
        draftType: string | null;
        draftConfidence: number | null;
        threadTitle: string | null;
        threadUrl: string | null;
        threadAuthor: string | null;
      }>;
      hasAnyPlanItems: boolean;
      stats: { pending_count: number };
    };

    // Scanned replies should surface even if the user has no plan_items yet.
    expect(body.hasAnyPlanItems).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('d-1');
    expect(body.items[0].draftId).toBe('d-1');
    expect(body.items[0].todoType).toBe('reply_thread');
    expect(body.items[0].source).toBe('discovery');
    expect(body.items[0].platform).toBe('x');
    expect(body.items[0].community).toBe('timeline');
    expect(body.items[0].externalUrl).toBe('https://x.com/example/status/123');
    expect(body.items[0].draftBody).toContain('Thanks for flagging');
    expect(body.items[0].draftType).toBe('reply');
    expect(body.items[0].draftConfidence).toBe(0.82);
    expect(body.items[0].threadTitle).toBe('Anyone know a good reply tool?');
    expect(body.items[0].threadAuthor).toBe('@founder');
    expect(body.stats.pending_count).toBe(1);
  });

  it('merges plan_items + drafts and returns replies first', async () => {
    const now = new Date();
    planRows = [
      {
        id: 'pi-1',
        kind: 'content_post',
        state: 'drafted',
        channel: 'x',
        scheduledAt: now,
        title: 'Scheduled post',
        description: null,
        createdAt: now,
        output: { draft_body: 'plan body' },
      },
    ];
    draftRows = [
      {
        draftId: 'd-1',
        draftStatus: 'pending',
        draftType: 'reply',
        postTitle: null,
        replyBody: 'reply body',
        confidenceScore: 0.7,
        whyItWorks: null,
        media: null,
        draftCreatedAt: now,
        threadId: 't-1',
        threadPlatform: 'reddit',
        threadCommunity: 'r/devtools',
        threadTitle: 'Thread title',
        threadBody: null,
        threadAuthor: 'u/somebody',
        threadUrl: 'https://reddit.com/r/devtools/comments/abc',
        threadUpvotes: 4,
        threadCommentCount: 1,
        threadPostedAt: null,
        threadDiscoveredAt: now,
      },
    ];
    statsRow = {
      publishedYesterday: 0,
      actedToday: 0,
      planPending: 1,
      anyItems: 1,
    };
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{ id: string; todoType: string }>;
      stats: { pending_count: number };
    };
    expect(body.items.map((i) => i.id)).toEqual(['d-1', 'pi-1']);
    expect(body.items[0].todoType).toBe('reply_thread');
    expect(body.items[1].todoType).toBe('approve_post');
    // pending_count reflects both sources.
    expect(body.stats.pending_count).toBe(2);
  });

  it('sets hasAnyPlanItems=true even when all items are terminal', async () => {
    statsRow = {
      publishedYesterday: 2,
      actedToday: 1,
      planPending: 0,
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
