import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertedThemes: unknown[] = [];
const insertedEntries: unknown[] = [];
const enqueueSlotMock = vi.fn();
const publishMock = vi.fn();

// Track how many times select().from() has been called within a single job
// so we can return the right fixture for each query in the processor's sequence:
//   1. products (product lookup)
//   2. xFollowerSnapshots
//   3. xTweetMetrics
//   4. xAnalyticsSummary
//   5. userPreferences
let selectCallIndex = 0;

const PRODUCT_ROW = {
  id: 'p-1',
  name: 'P',
  description: 'd',
  valueProp: 'v',
  keywords: [],
  lifecyclePhase: 'launched',
};

// Use sentinel symbols so insert() can route to the right fixture
const WEEKLY_THEMES_SENTINEL = '__weekly_themes__';
const XCONTENT_CALENDAR_SENTINEL = '__x_content_calendar__';
const ACTIVITY_EVENTS_SENTINEL = '__activity_events__';

vi.mock('@/lib/db/schema', () => ({
  // Sentinel strings used by db.insert() routing
  weeklyThemes: WEEKLY_THEMES_SENTINEL,
  xContentCalendar: XCONTENT_CALENDAR_SENTINEL,
  activityEvents: ACTIVITY_EVENTS_SENTINEL,
  // Schema columns referenced in the processor (used in where/orderBy clauses)
  products: { id: 'id', userId: 'userId' },
  xFollowerSnapshots: { userId: 'userId', snapshotAt: 'snapshotAt' },
  xTweetMetrics: {
    userId: 'userId',
    tweetId: 'tweetId',
    impressions: 'impressions',
    bookmarks: 'bookmarks',
    likes: 'likes',
    replies: 'replies',
    retweets: 'retweets',
  },
  xAnalyticsSummary: {
    userId: 'userId',
    computedAt: 'computedAt',
    bestContentTypes: 'bestContentTypes',
    bestPostingHours: 'bestPostingHours',
    audienceGrowthRate: 'audienceGrowthRate',
    engagementRate: 'engagementRate',
  },
  userPreferences: { userId: 'userId', postingHoursUtc: 'postingHoursUtc' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, val: unknown) => ({ val }),
  desc: (col: unknown) => col,
  and: (...args: unknown[]) => args,
  gte: (_col: unknown, val: unknown) => ({ val }),
  inArray: (_col: unknown, arr: unknown) => ({ arr }),
}));

vi.mock('@/lib/db', () => {
  const db = {
    select: () => ({
      from: () => {
        const idx = selectCallIndex++;
        const makeChain = (rows: unknown[]) => ({
          where: () => ({
            orderBy: () => ({ limit: () => rows }),
            limit: () => rows,
          }),
          limit: () => rows,
        });
        switch (idx) {
          case 0: // products
            return makeChain([PRODUCT_ROW]);
          case 1: // xFollowerSnapshots
            return makeChain([]);
          case 2: // xTweetMetrics
            return makeChain([]);
          case 3: // xAnalyticsSummary
            return makeChain([]);
          case 4: // userPreferences — empty → processor uses default postingHours [14, 17, 21]
            return makeChain([]);
          default:
            return makeChain([]);
        }
      },
    }),
    insert: (table: unknown) => ({
      values: (v: unknown) => ({
        returning: () => {
          if (table === WEEKLY_THEMES_SENTINEL) {
            insertedThemes.push(v);
            return [{ id: 'theme-1' }];
          }
          if (table === XCONTENT_CALENDAR_SENTINEL) {
            insertedEntries.push(v);
            return Array.isArray(v)
              ? (v as Array<Record<string, unknown>>).map((e, i) => ({
                  id: `row-${i}`,
                  scheduledAt: e.scheduledAt as Date,
                  contentType: e.contentType,
                  topic: e.topic,
                  state: e.state,
                  isWhiteSpace: e.isWhiteSpace ?? false,
                  angle: e.angle ?? null,
                  themeId: e.themeId,
                }))
              : [];
          }
          // activityEvents and anything else
          return [];
        },
        onConflictDoNothing: () => ({ returning: () => [] }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({}) }) }),
    delete: () => ({ where: () => ({ returning: () => [] }) }),
  };
  return { db };
});

vi.mock('@/lib/queue', () => ({
  enqueueCalendarSlotDraft: enqueueSlotMock,
  todoSeedQueue: { add: vi.fn() },
}));
vi.mock('@/lib/redis', () => ({ publishUserEvent: publishMock }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'calendar-planner' }) }));
vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(async () => ({
    results: [
      {
        phase: 'growth',
        weeklyStrategy: 'prove the pricing thesis',
        thesis: 'cheap pricing is the distribution moat',
        thesisSource: 'milestone',
        milestoneContext: 'shipped $19/mo',
        fallbackMode: null,
        whiteSpaceDayOffsets: [5, 6],
        entries: [
          { dayOffset: 0, hour: 14, contentType: 'metric', angle: 'claim', topic: 't1' },
          { dayOffset: 1, hour: 14, contentType: 'educational', angle: 'story', topic: 't2' },
        ],
      },
    ],
    errors: [],
    usage: { costUsd: 0.01 },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  insertedThemes.length = 0;
  insertedEntries.length = 0;
  selectCallIndex = 0;
});

function makeJob(id: string) {
  return {
    id,
    data: {
      schemaVersion: 1,
      userId: 'u-1',
      productId: 'p-1',
      channel: 'x',
      startDate: new Date('2026-04-20T00:00:00Z').toISOString(),
    },
  } as never;
}

describe('processCalendarPlan persists thesis', () => {
  it('inserts one weekly_themes row with thesis + thesisSource', async () => {
    const { processCalendarPlan } = await import('../calendar-plan');
    await processCalendarPlan(makeJob('job-1'));

    expect(insertedThemes.length).toBe(1);
    const theme = insertedThemes[0] as { thesis: string; thesisSource: string };
    expect(theme.thesis).toContain('pricing');
    expect(theme.thesisSource).toBe('milestone');
  });

  it('sets angle + themeId on non-white-space entries and isWhiteSpace on reserved days', async () => {
    const { processCalendarPlan } = await import('../calendar-plan');
    await processCalendarPlan(makeJob('job-2'));

    const entriesRow = insertedEntries.find((v) => Array.isArray(v));
    expect(Array.isArray(entriesRow)).toBe(true);
    const entries = entriesRow as Array<{
      angle: string | null;
      themeId: string;
      isWhiteSpace: boolean;
      state: string;
    }>;
    const nonWs = entries.filter((e) => !e.isWhiteSpace);
    const ws = entries.filter((e) => e.isWhiteSpace);
    expect(nonWs.length).toBeGreaterThan(0);
    expect(nonWs[0].angle).toBe('claim');
    expect(nonWs[0].themeId).toBe('theme-1');
    // 2 white-space days × 3 posting hours (default fallback [14, 17, 21]) = 6
    expect(ws.length).toBe(6);
    for (const w of ws) {
      expect(w.angle).toBeNull();
      expect(w.state).toBe('ready'); // white-space rows don't need drafting
    }
  });

  it('does not enqueue slot-draft for white-space rows', async () => {
    const { processCalendarPlan } = await import('../calendar-plan');
    await processCalendarPlan(makeJob('job-3'));
    const calls = enqueueSlotMock.mock.calls;
    // 2 planner entries on days 0 and 1 at hour 14 (matches postingHours default).
    // White-space days (5, 6) must NOT generate slot-draft jobs.
    expect(calls.length).toBe(2);
  });
});
