import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { RedditChannelResearchJobData } from '@/lib/queue';

// ---------------------------------------------------------------------------
// Hoisted shared state — the mock factories below close over these so each
// test case can rewire the skill output, the enrichment responses, and the
// pre-seeded product_reddit_channels rows without re-importing the processor.
// ---------------------------------------------------------------------------

interface StoredRow {
  productId: string;
  userId: string;
  subreddit: string;
  memberCount: number | null;
  fitScore: number;
  rulesSummary: string;
  activity: { postsLast7d: number; commentsLast7d: number; medianUpvotes: number };
  rank: number;
  source: 'auto' | 'manual';
  disabled: boolean;
}

const hoisted = vi.hoisted(() => ({
  /** Rows in product_reddit_channels (simulated). */
  storedRows: [] as StoredRow[],
  /** Rows in products. */
  productRows: [
    {
      id: 'p-1',
      name: 'TestProduct',
      description: 'a product',
      valueProp: 'helps founders ship faster',
    },
  ] as Array<{
    id: string;
    name: string;
    description: string;
    valueProp: string | null;
  }>,
  /** Default skill output — six candidates, descending fitScore. */
  skillResult: {
    candidates: [
      { subreddit: 'sub_a', memberCountApprox: 100, rulesSummary: 'rules a', fitRationale: 'why a', fitScore: 0.95 },
      { subreddit: 'sub_b', memberCountApprox: 200, rulesSummary: 'rules b', fitRationale: 'why b', fitScore: 0.85 },
      { subreddit: 'sub_c', memberCountApprox: 300, rulesSummary: 'rules c', fitRationale: 'why c', fitScore: 0.75 },
      { subreddit: 'sub_d', memberCountApprox: 400, rulesSummary: 'rules d', fitRationale: 'why d', fitScore: 0.65 },
      { subreddit: 'sub_e', memberCountApprox: 500, rulesSummary: 'rules e', fitRationale: 'why e', fitScore: 0.55 },
      { subreddit: 'sub_f', memberCountApprox: 600, rulesSummary: 'rules f', fitRationale: 'why f', fitScore: 0.45 },
    ] as Array<{
      subreddit: string;
      memberCountApprox: number | null;
      rulesSummary: string;
      fitRationale: string;
      fitScore: number;
    }>,
    costUsd: 0.05,
  },
  /** Per-subreddit override map for fetchSubredditAbout. */
  aboutBySubreddit: new Map<string, { memberCount: number | null }>(),
  /** Per-subreddit override map for fetchSubredditActivity. */
  activityBySubreddit: new Map<
    string,
    { postsLast7d: number; commentsLast7d: number; medianUpvotes: number }
  >(),
  /** Counter so tests can assert the skill was (or was not) invoked. */
  runForkSkillCalls: 0,
  /** Counter so tests can assert enrichment was (or was not) invoked. */
  fetchAboutCalls: 0,
  fetchActivityCalls: 0,
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Drizzle eq/and are reduced to sentinel objects so the db mock can pattern-
// match against the columns the processor filters on.
interface EqSentinel { __eq: { col: unknown; val: unknown } }
interface AndSentinel { __and: EqSentinel[] }

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, val: unknown): EqSentinel => ({ __eq: { col, val } }),
    and: (...clauses: EqSentinel[]): AndSentinel => ({ __and: clauses }),
  };
});

// Schema table sentinels carry a `_kind` discriminator the db mock reads
// to route select / delete / insert by table.
vi.mock('@/lib/db/schema', () => ({
  productRedditChannels: {
    _kind: 'productRedditChannels',
    productId: { _col: 'productId' },
    source: { _col: 'source' },
    id: { _col: 'id' },
  },
  products: {
    _kind: 'products',
    id: { _col: 'id' },
    name: { _col: 'name' },
    description: { _col: 'description' },
    valueProp: { _col: 'valueProp' },
  },
}));

function matchesFilter(
  row: Record<string, unknown>,
  filter: EqSentinel | AndSentinel | undefined,
): boolean {
  if (!filter) return true;
  if ('__and' in filter) return filter.__and.every((c) => matchesFilter(row, c));
  if ('__eq' in filter) {
    const col = filter.__eq.col as { _col?: string };
    const key = col?._col;
    if (!key) return false;
    return row[key] === filter.__eq.val;
  }
  return false;
}

function projectRow(
  row: Record<string, unknown>,
  cols: Record<string, { _col?: string }> | undefined,
): Record<string, unknown> {
  if (!cols) return row;
  const out: Record<string, unknown> = {};
  for (const [alias, ref] of Object.entries(cols)) {
    const key = ref?._col;
    if (key) out[alias] = row[key];
  }
  return out;
}

function tableRowsFor(table: { _kind?: string } | undefined): Record<string, unknown>[] {
  if (!table) return [];
  switch (table._kind) {
    case 'productRedditChannels':
      return hoisted.storedRows as unknown as Record<string, unknown>[];
    case 'products':
      return hoisted.productRows as unknown as Record<string, unknown>[];
    default:
      return [];
  }
}

vi.mock('@/lib/db', () => {
  // Lightweight select / delete / insert builder. Supports the surface the
  // processor exercises: select(projection?).from(table).where(filter).limit(n)
  // delete(table).where(filter), insert(table).values(rows[]).
  function makeBuilder() {
    let table: { _kind?: string } | undefined;
    let projection: Record<string, { _col?: string }> | undefined;
    let filter: EqSentinel | AndSentinel | undefined;
    let limitN = Infinity;
    const builder = {
      from(t: { _kind?: string }) {
        table = t;
        return builder;
      },
      where(f: EqSentinel | AndSentinel) {
        filter = f;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return materialize();
      },
      then(resolve: (v: unknown[]) => unknown) {
        return Promise.resolve(materialize()).then(resolve);
      },
    };
    function materialize(): unknown[] {
      const rows = tableRowsFor(table);
      const matching = rows.filter((r) => matchesFilter(r, filter));
      const projected = matching.map((r) => projectRow(r, projection));
      return Number.isFinite(limitN) ? projected.slice(0, limitN) : projected;
    }
    return { builder, setProjection: (p?: Record<string, { _col?: string }>) => { projection = p; } };
  }

  interface TxLike {
    delete(t: { _kind?: string }): {
      where(f: EqSentinel | AndSentinel): Promise<void>;
    };
    insert(t: { _kind?: string }): {
      values(rows: StoredRow | StoredRow[]): Promise<void>;
    };
  }
  const tx: TxLike = {
    delete(t: { _kind?: string }) {
      let filter: EqSentinel | AndSentinel | undefined;
      return {
        where(f: EqSentinel | AndSentinel) {
          filter = f;
          if (t._kind === 'productRedditChannels') {
            hoisted.storedRows = hoisted.storedRows.filter(
              (r) => !matchesFilter(r as unknown as Record<string, unknown>, filter),
            );
          }
          return Promise.resolve();
        },
      };
    },
    insert(t: { _kind?: string }) {
      return {
        values(rows: StoredRow | StoredRow[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          if (t._kind === 'productRedditChannels') {
            for (const r of list) hoisted.storedRows.push(r);
          }
          return Promise.resolve();
        },
      };
    },
  };

  return {
    db: {
      select(projection?: Record<string, { _col?: string }>) {
        const { builder, setProjection } = makeBuilder();
        setProjection(projection);
        return builder;
      },
      transaction: async (fn: (t: TxLike) => Promise<unknown>) => fn(tx),
    },
  };
});

vi.mock('@/skills/run-fork-skill', () => ({
  runForkSkill: vi.fn(async () => {
    hoisted.runForkSkillCalls += 1;
    return {
      result: hoisted.skillResult,
      usage: { costUsd: hoisted.skillResult.costUsd, inputTokens: 0, outputTokens: 0 },
    };
  }),
}));

vi.mock('@/lib/reddit-channel-enrichment', () => ({
  fetchSubredditAbout: vi.fn(async (sub: string) => {
    hoisted.fetchAboutCalls += 1;
    return hoisted.aboutBySubreddit.get(sub) ?? { memberCount: 10_000 };
  }),
  fetchSubredditActivity: vi.fn(async (sub: string) => {
    hoisted.fetchActivityCalls += 1;
    return (
      hoisted.activityBySubreddit.get(sub) ?? {
        postsLast7d: 1,
        commentsLast7d: 2,
        medianUpvotes: 3,
      }
    );
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  }),
  loggerForJob: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(
  overrides: Partial<RedditChannelResearchJobData> = {},
): Job<RedditChannelResearchJobData> {
  return {
    id: 'job-rcr-1',
    name: 'research',
    queueName: 'reddit-channel-research',
    data: {
      schemaVersion: 1,
      userId: 'u-1',
      productId: 'p-1',
      force: false,
      traceId: 'trace-1',
      ...overrides,
    },
  } as Job<RedditChannelResearchJobData>;
}

beforeEach(() => {
  hoisted.storedRows = [];
  hoisted.productRows = [
    {
      id: 'p-1',
      name: 'TestProduct',
      description: 'a product',
      valueProp: 'helps founders ship faster',
    },
  ];
  hoisted.skillResult = {
    candidates: [
      { subreddit: 'sub_a', memberCountApprox: 100, rulesSummary: 'rules a', fitRationale: 'why a', fitScore: 0.95 },
      { subreddit: 'sub_b', memberCountApprox: 200, rulesSummary: 'rules b', fitRationale: 'why b', fitScore: 0.85 },
      { subreddit: 'sub_c', memberCountApprox: 300, rulesSummary: 'rules c', fitRationale: 'why c', fitScore: 0.75 },
      { subreddit: 'sub_d', memberCountApprox: 400, rulesSummary: 'rules d', fitRationale: 'why d', fitScore: 0.65 },
      { subreddit: 'sub_e', memberCountApprox: 500, rulesSummary: 'rules e', fitRationale: 'why e', fitScore: 0.55 },
      { subreddit: 'sub_f', memberCountApprox: 600, rulesSummary: 'rules f', fitRationale: 'why f', fitScore: 0.45 },
    ],
    costUsd: 0.05,
  };
  hoisted.aboutBySubreddit = new Map();
  hoisted.activityBySubreddit = new Map();
  hoisted.runForkSkillCalls = 0;
  hoisted.fetchAboutCalls = 0;
  hoisted.fetchActivityCalls = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processRedditChannelResearch', () => {
  it('writes top-3 by fitScore DESC on first run with source=auto, rank 1/2/3, enrichment populated', async () => {
    hoisted.aboutBySubreddit.set('sub_a', { memberCount: 250_000 });
    hoisted.aboutBySubreddit.set('sub_b', { memberCount: 150_000 });
    hoisted.aboutBySubreddit.set('sub_c', { memberCount: 50_000 });
    hoisted.activityBySubreddit.set('sub_a', {
      postsLast7d: 30,
      commentsLast7d: 120,
      medianUpvotes: 15,
    });

    const { processRedditChannelResearch } = await import('../reddit-channel-research');

    await processRedditChannelResearch(makeJob());

    expect(hoisted.storedRows).toHaveLength(3);

    const ordered = [...hoisted.storedRows].sort((a, b) => a.rank - b.rank);

    expect(ordered.map((r) => r.subreddit)).toEqual(['sub_a', 'sub_b', 'sub_c']);
    expect(ordered.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(ordered.every((r) => r.source === 'auto')).toBe(true);
    expect(ordered.every((r) => r.disabled === false)).toBe(true);
    expect(ordered[0]!.fitScore).toBeCloseTo(0.95);
    expect(ordered[0]!.memberCount).toBe(250_000);
    expect(ordered[1]!.memberCount).toBe(150_000);
    expect(ordered[2]!.memberCount).toBe(50_000);
    expect(ordered[0]!.activity).toEqual({
      postsLast7d: 30,
      commentsLast7d: 120,
      medianUpvotes: 15,
    });
    expect(ordered.every((r) => r.productId === 'p-1' && r.userId === 'u-1')).toBe(true);
    expect(hoisted.runForkSkillCalls).toBe(1);
  });

  it('is a no-op when force=false and at least one auto row already exists', async () => {
    hoisted.storedRows = [
      {
        productId: 'p-1',
        userId: 'u-1',
        subreddit: 'preseed',
        memberCount: 999,
        fitScore: 0.9,
        rulesSummary: 'rules',
        activity: { postsLast7d: 0, commentsLast7d: 0, medianUpvotes: 0 },
        rank: 1,
        source: 'auto',
        disabled: false,
      },
    ];

    const { processRedditChannelResearch } = await import('../reddit-channel-research');

    await processRedditChannelResearch(makeJob({ force: false }));

    expect(hoisted.runForkSkillCalls).toBe(0);
    expect(hoisted.fetchAboutCalls).toBe(0);
    expect(hoisted.fetchActivityCalls).toBe(0);
    expect(hoisted.storedRows).toHaveLength(1);
    expect(hoisted.storedRows[0]!.subreddit).toBe('preseed');
  });

  it('clears prior autos and re-writes top-3 when force=true; preserves manual rows', async () => {
    hoisted.storedRows = [
      {
        productId: 'p-1',
        userId: 'u-1',
        subreddit: 'old_auto',
        memberCount: 1,
        fitScore: 0.5,
        rulesSummary: '',
        activity: { postsLast7d: 0, commentsLast7d: 0, medianUpvotes: 0 },
        rank: 1,
        source: 'auto',
        disabled: false,
      },
      {
        productId: 'p-1',
        userId: 'u-1',
        subreddit: 'founder_pick',
        memberCount: 42,
        fitScore: 0,
        rulesSummary: 'manual',
        activity: { postsLast7d: 0, commentsLast7d: 0, medianUpvotes: 0 },
        rank: 99,
        source: 'manual',
        disabled: false,
      },
    ];

    const { processRedditChannelResearch } = await import('../reddit-channel-research');

    await processRedditChannelResearch(makeJob({ force: true }));

    const autos = hoisted.storedRows.filter((r) => r.source === 'auto');
    const manuals = hoisted.storedRows.filter((r) => r.source === 'manual');

    expect(autos).toHaveLength(3);
    expect(autos.map((r) => r.subreddit).sort()).toEqual(['sub_a', 'sub_b', 'sub_c']);
    expect(autos.every((r) => r.subreddit !== 'old_auto')).toBe(true);
    expect(manuals).toHaveLength(1);
    expect(manuals[0]!.subreddit).toBe('founder_pick');
    expect(hoisted.runForkSkillCalls).toBe(1);
  });

  it('writes zero rows and exits cleanly when the skill returns an empty candidates list', async () => {
    hoisted.skillResult = { candidates: [], costUsd: 0.01 };

    const { processRedditChannelResearch } = await import('../reddit-channel-research');

    await expect(processRedditChannelResearch(makeJob())).resolves.toBeUndefined();

    expect(hoisted.storedRows).toHaveLength(0);
    expect(hoisted.runForkSkillCalls).toBe(1);
    expect(hoisted.fetchAboutCalls).toBe(0);
    expect(hoisted.fetchActivityCalls).toBe(0);
  });

  it('falls back to memberCountApprox when fetchSubredditAbout returns null memberCount', async () => {
    // sub_a is the top-fit candidate, give /about.json null and assert
    // the persisted row keeps the candidate's memberCountApprox (100).
    hoisted.aboutBySubreddit.set('sub_a', { memberCount: null });

    const { processRedditChannelResearch } = await import('../reddit-channel-research');

    await processRedditChannelResearch(makeJob());

    const top = hoisted.storedRows.find((r) => r.subreddit === 'sub_a');
    expect(top).toBeDefined();
    expect(top!.memberCount).toBe(100);
  });

  it('aborts cleanly when productId does not resolve to a product row', async () => {
    hoisted.productRows = [];

    const { processRedditChannelResearch } = await import('../reddit-channel-research');

    await processRedditChannelResearch(makeJob({ productId: 'p-missing' }));

    expect(hoisted.runForkSkillCalls).toBe(0);
    expect(hoisted.fetchAboutCalls).toBe(0);
    expect(hoisted.storedRows).toHaveLength(0);
  });
});
