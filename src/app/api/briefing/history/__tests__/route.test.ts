import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// Three query paths fan out from GET (in implementation order):
//   (a) drafts ⨯ threads (handed_off|posted in window) — projection
//       includes `replyBody`. Renders reply-shaped history rows.
//   (b) plan_items (state='completed', kind='content_post', within
//       window) — projection includes `output` + `completedAt`. Renders
//       posted-original-post history rows.
//   (c) activity_events (eventType='post_published') — projection uses
//       sql<string>``(${activityEvents.metadataJson} ->> 'planItemId')``
//       so the mock dispatches via field presence: rows with `planItemId`
//       and `externalUrl` keys are the activity-event lookup.
//
// The mock dispatches on field presence so the route-level call order
// doesn't couple the test to the implementation.

type DraftJoinRow = {
  draftId: string;
  draftStatus: 'handed_off' | 'posted';
  draftType: 'reply' | 'original_post';
  postTitle: string | null;
  replyBody: string;
  confidenceScore: number | null;
  whyItWorks: string | null;
  media: unknown;
  draftCreatedAt: Date;
  draftUpdatedAt: Date;
  threadId: string;
  threadPlatform: string;
  threadExternalId: string | null;
  threadCommunity: string | null;
  threadTitle: string | null;
  threadBody: string | null;
  threadAuthor: string | null;
  threadUrl: string | null;
  threadUpvotes: number | null;
  threadCommentCount: number | null;
  threadPostedAt: Date | null;
  threadDiscoveredAt: Date;
  threadLikesCount: number | null;
  threadRepostsCount: number | null;
  threadRepliesCount: number | null;
  threadViewsCount: number | null;
  threadIsRepost: boolean;
  threadOriginalUrl: string | null;
  threadOriginalAuthorUsername: string | null;
  threadSurfacedVia: string[] | null;
};
type PlanRow = {
  id: string;
  output: Record<string, unknown> | null;
  title: string;
  channel: string | null;
  completedAt: Date | null;
  createdAt: Date;
};
type ActivityEventRow = {
  planItemId: string | null;
  externalUrl: string | null;
};

let draftRows: DraftJoinRow[] = [];
let planRows: PlanRow[] = [];
let eventRows: ActivityEventRow[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isDrafts = fields.includes('replyBody');
      const isPlanItems =
        fields.includes('output') && fields.includes('completedAt');
      const isActivityEvents =
        fields.includes('planItemId') && fields.includes('externalUrl');

      // Drafts ⨯ threads: `.from(...).innerJoin(...).where(...).orderBy(...)`
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

      // plan_items: `.from(...).where(...).orderBy(...)`
      if (isPlanItems) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => Promise.resolve(planRows),
            }),
          }),
        };
      }

      // activity_events: `.from(...).where(...)` — awaited directly.
      if (isActivityEvents) {
        return {
          from: () => ({
            where: () => Promise.resolve(eventRows),
          }),
        };
      }

      // Fallback (shouldn't be hit) — empty result set with all chains.
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
          innerJoin: () => ({
            where: () => ({
              orderBy: () => Promise.resolve([]),
            }),
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
    isNotNull: () => ({}),
    desc: (x: unknown) => x,
    sql: Object.assign(
      (..._args: unknown[]) => ({ mapWith: () => ({}) }),
      { raw: () => ({}) },
    ),
  };
});

beforeEach(() => {
  authUserId = 'user-1';
  draftRows = [];
  planRows = [];
  eventRows = [];
});

describe('GET /api/briefing/history', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns an empty feed when no rows exist', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      windowDays: number;
    };
    expect(body.items).toEqual([]);
    expect(body.windowDays).toBe(7);
  });

  it('projects handed_off reply drafts into history items', async () => {
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 60 * 60 * 1000);
    draftRows = [
      {
        draftId: 'd-1',
        draftStatus: 'handed_off',
        draftType: 'reply',
        postTitle: null,
        replyBody: 'Thanks for flagging.',
        confidenceScore: 0.8,
        whyItWorks: null,
        media: null,
        draftCreatedAt: updatedAt,
        draftUpdatedAt: updatedAt,
        threadId: 't-1',
        threadPlatform: 'x',
        threadExternalId: '12345',
        threadCommunity: 'timeline',
        threadTitle: 'A thread title',
        threadBody: 'A thread body',
        threadAuthor: '@founder',
        threadUrl: 'https://x.com/founder/status/12345',
        threadUpvotes: null,
        threadCommentCount: null,
        threadPostedAt: null,
        threadDiscoveredAt: updatedAt,
        threadLikesCount: null,
        threadRepostsCount: null,
        threadRepliesCount: null,
        threadViewsCount: null,
        threadIsRepost: false,
        threadOriginalUrl: null,
        threadOriginalAuthorUsername: null,
        threadSurfacedVia: null,
      },
    ];
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        status: string;
        draftType: string;
        draftBody: string;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('d-1');
    expect(body.items[0].status).toBe('handed_off');
    expect(body.items[0].draftType).toBe('reply');
    expect(body.items[0].draftBody).toBe('Thanks for flagging.');
  });

  it('includes completed content_post plan_items in the history feed', async () => {
    const now = Date.now();
    const draftUpdatedAt = new Date(now - 30 * 60 * 1000); // 30m ago
    const planCompletedAt = new Date(now - 2 * 60 * 60 * 1000); // 2h ago
    draftRows = [
      {
        draftId: 'd-1',
        draftStatus: 'handed_off',
        draftType: 'reply',
        postTitle: null,
        replyBody: 'reply body',
        confidenceScore: 0.7,
        whyItWorks: null,
        media: null,
        draftCreatedAt: draftUpdatedAt,
        draftUpdatedAt,
        threadId: 't-1',
        threadPlatform: 'x',
        threadExternalId: '11',
        threadCommunity: '',
        threadTitle: 'Reply target',
        threadBody: 'Some body',
        threadAuthor: '@user',
        threadUrl: 'https://x.com/u/status/11',
        threadUpvotes: null,
        threadCommentCount: null,
        threadPostedAt: null,
        threadDiscoveredAt: draftUpdatedAt,
        threadLikesCount: null,
        threadRepostsCount: null,
        threadRepliesCount: null,
        threadViewsCount: null,
        threadIsRepost: false,
        threadOriginalUrl: null,
        threadOriginalAuthorUsername: null,
        threadSurfacedVia: null,
      },
    ];
    planRows = [
      {
        id: 'pi-1',
        output: { draft_body: 'shipped today: Hello world!' },
        title: 'Scheduled X post',
        channel: 'x',
        completedAt: planCompletedAt,
        createdAt: planCompletedAt,
      },
    ];
    eventRows = [
      {
        planItemId: 'pi-1',
        externalUrl: 'https://x.com/me/status/999',
      },
    ];
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        status: string;
        draftType: 'reply' | 'original_post';
        draftBody: string | null;
        platform: string;
        externalUrl: string | null;
        expiresAt: string;
      }>;
    };

    expect(body.items).toHaveLength(2);

    const reply = body.items.find((i) => i.draftType === 'reply');
    const post = body.items.find((i) => i.draftType === 'original_post');

    expect(reply).toBeDefined();
    expect(reply?.id).toBe('d-1');
    expect(reply?.status).toBe('handed_off');

    expect(post).toBeDefined();
    expect(post?.id).toBe('pi-1');
    expect(post?.status).toBe('posted');
    expect(post?.draftBody).toBe('shipped today: Hello world!');
    expect(post?.platform).toBe('x');
    expect(post?.externalUrl).toBe('https://x.com/me/status/999');

    // Ordering: newest first by completedAt/updatedAt desc.
    // draftUpdatedAt (30m ago) is newer than planCompletedAt (2h ago),
    // so reply must come before post in items[].
    expect(body.items[0].id).toBe('d-1');
    expect(body.items[1].id).toBe('pi-1');
  });

  it('projects posted plan_items even without a matching activity_event (externalUrl null)', async () => {
    const completedAt = new Date(Date.now() - 60 * 60 * 1000);
    planRows = [
      {
        id: 'pi-no-event',
        output: { draft_body: 'posted via legacy path' },
        title: 'Legacy post',
        channel: 'x',
        completedAt,
        createdAt: completedAt,
      },
    ];
    eventRows = [];
    const { GET } = await import('../route');
    const res = await GET();
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        externalUrl: string | null;
        draftBody: string | null;
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('pi-no-event');
    expect(body.items[0].externalUrl).toBeNull();
    expect(body.items[0].draftBody).toBe('posted via legacy path');
  });
});
