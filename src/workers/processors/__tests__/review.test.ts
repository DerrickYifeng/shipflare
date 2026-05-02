import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { ReviewJobData } from '@/lib/queue/types';

// ---------------------------------------------------------------------------
// Hoisted shared state — mock factories close over these to capture calls
// the tests assert on.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  // Captures every payload passed to db.update(...).set(...). The processor
  // does at most one update on `drafts` per job, but we don't care — we just
  // want to read the reviewJson back out.
  capturedSetPayloads: [] as Array<Record<string, unknown>>,
  // Default review result returned by runForkSkill — tests can override
  // before importing the processor.
  reviewResult: {
    verdict: 'FAIL' as 'PASS' | 'FAIL' | 'REVISE',
    score: 0.2,
    checks: [] as Array<{ name: string; result: 'PASS' | 'FAIL'; detail: string }>,
    issues: ['diagnostic-from-above'],
    suggestions: ['rewrite with first-person'],
    slopFingerprint: ['diagnostic_from_above', 'no_first_person'] as string[],
  },
}));

// ---------------------------------------------------------------------------
// In-memory draft / thread / product fixtures
// ---------------------------------------------------------------------------

const draftRow = {
  id: 'draft-1',
  userId: 'u-1',
  threadId: 'thread-1',
  status: 'pending',
  draftType: 'reply',
  postTitle: null,
  replyBody: 'hello world',
  confidenceScore: 0.7,
  whyItWorks: 'because',
  ftcDisclosure: null,
  reviewVerdict: null,
  reviewScore: null,
  reviewJson: null,
  engagementDepth: 0,
  planItemId: null,
  media: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const threadRow = {
  id: 'thread-1',
  userId: 'u-1',
  community: 'r/test',
  platform: 'reddit',
  title: 'Some thread',
  body: 'thread body',
};

const productRow = {
  id: 'p-1',
  name: 'TestProduct',
  description: 'a product',
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: (table: { _kind?: string } | unknown) => ({
        where: () => ({
          limit: () => {
            // The processor selects from drafts, threads, products,
            // userPreferences, channels — return a single matching row
            // for each based on the table sentinel set below.
            const t = table as { _kind?: string };
            switch (t?._kind) {
              case 'drafts':
                return [draftRow];
              case 'threads':
                return [threadRow];
              case 'products':
                return [productRow];
              case 'userPreferences':
                return [];
              case 'channels':
                return [];
              default:
                return [];
            }
          },
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: () => {
          hoisted.capturedSetPayloads.push(payload);
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  // The processor only uses these as table references — our db mock decides
  // the row to return via the `_kind` sentinel. Drizzle's actual table
  // helpers aren't needed in this test path.
  drafts: { _kind: 'drafts' },
  threads: { _kind: 'threads' },
  products: { _kind: 'products' },
  channels: { _kind: 'channels' },
  userPreferences: { _kind: 'userPreferences' },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    gte: () => ({}),
    sql: Object.assign(() => ({}), { raw: () => ({}) }),
  };
});

vi.mock('@/skills/run-fork-skill', () => ({
  runForkSkill: vi.fn(async () => ({
    result: hoisted.reviewResult,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  })),
}));

// validating-draft schema is consumed only as a parse target by runForkSkill,
// which is itself mocked above. We still need the import to resolve, so
// re-export the real schema from the source module — no override.
vi.mock('@/lib/redis', () => ({
  publishUserEvent: vi.fn(async () => {}),
}));

vi.mock('@/lib/queue', () => ({
  enqueueDream: vi.fn(async () => {}),
  enqueuePosting: vi.fn(async () => {}),
}));

vi.mock('@/lib/queue/types', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queue/types')>(
    '@/lib/queue/types',
  );
  return {
    ...actual,
    getTraceId: () => 'trace-1',
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  loggerForJob: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    constructor(_userId: string, _productId: string) {}
  },
}));

vi.mock('@/memory/dream', () => ({
  AgentDream: class {
    constructor(_store: unknown) {}
    async logInsight(_msg: string) {}
    async shouldDistill() {
      return false;
    }
  },
}));

vi.mock('@/memory/prompt-builder', () => ({
  buildMemoryPrompt: vi.fn(async () => ''),
}));

vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEvent: vi.fn(async () => {}),
}));

vi.mock('@/lib/cost-bucket', () => ({
  addCost: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(): Job<ReviewJobData> {
  return {
    id: 'job-review-1',
    name: 'review',
    data: {
      userId: 'u-1',
      draftId: 'draft-1',
      productId: 'p-1',
      traceId: 'trace-1',
    },
  } as Job<ReviewJobData>;
}

beforeEach(() => {
  hoisted.capturedSetPayloads.length = 0;
  hoisted.reviewResult = {
    verdict: 'FAIL',
    score: 0.2,
    checks: [],
    issues: ['diagnostic-from-above'],
    suggestions: ['rewrite with first-person'],
    slopFingerprint: ['diagnostic_from_above', 'no_first_person'],
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processReview — slopFingerprint persistence', () => {
  it('writes slopFingerprint into drafts.review_json alongside checks/issues/suggestions', async () => {
    const { processReview } = await import('../review');

    await processReview(makeJob());

    expect(hoisted.capturedSetPayloads.length).toBeGreaterThan(0);
    const payload = hoisted.capturedSetPayloads[0]!;
    const reviewJson = payload.reviewJson as {
      checks: unknown;
      issues: unknown;
      suggestions: unknown;
      slopFingerprint: unknown;
    };

    expect(reviewJson).toBeDefined();
    expect(reviewJson.slopFingerprint).toEqual([
      'diagnostic_from_above',
      'no_first_person',
    ]);
    expect(reviewJson.issues).toEqual(['diagnostic-from-above']);
    expect(reviewJson.suggestions).toEqual(['rewrite with first-person']);
  });

  it('defaults slopFingerprint to [] when the skill omits it', async () => {
    // Simulate a legacy / forgiving runForkSkill payload that did not include
    // slopFingerprint at all. The processor's `?? []` should kick in.
    hoisted.reviewResult = {
      verdict: 'PASS',
      score: 0.9,
      checks: [],
      issues: [],
      suggestions: [],
      // intentionally cast through unknown to drop the field for this run
    } as unknown as typeof hoisted.reviewResult;

    const { processReview } = await import('../review');
    await processReview(makeJob());

    expect(hoisted.capturedSetPayloads.length).toBeGreaterThan(0);
    const payload = hoisted.capturedSetPayloads[0]!;
    const reviewJson = payload.reviewJson as { slopFingerprint: unknown };
    expect(reviewJson.slopFingerprint).toEqual([]);
  });
});
