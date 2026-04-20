import type { Page } from '@playwright/test';

const MOCK_PROFILE = {
  url: 'https://shipflare.dev',
  name: 'ShipFlare',
  description: 'AI marketing autopilot for indie developers',
  keywords: ['marketing', 'reddit', 'seo', 'automation'],
  valueProp: 'Automates Reddit marketing so indie devs can focus on building.',
  ogImage: null,
  seoAudit: { score: 72, checks: [], recommendations: [] },
};

/**
 * Intercept POST /api/onboarding/extract with a successful mock response.
 * Avoids real URL scraping during tests.
 */
export async function mockExtractSuccess(page: Page) {
  await page.route('**/api/onboarding/extract', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_PROFILE),
    }),
  );
}

/**
 * Intercept POST /api/onboarding/extract with an error response.
 * Simulates a bad URL / scraping failure.
 */
export async function mockExtractFailure(page: Page) {
  await page.route('**/api/onboarding/extract', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Failed to extract profile from URL' }),
    }),
  );
}

// ---------------------------------------------------------------------------
// v3 onboarding mocks — planner chain and commit.
//
// The real planner runs two LLM calls (Sonnet + Haiku) which take 8-15s and
// hit live billing. E2E tests MUST stub these to stay deterministic.
// ---------------------------------------------------------------------------

const MOCK_STRATEGIC_PATH = {
  narrative:
    'A pre-launch playbook for an indie AI marketing tool. Focus on building an audience of engineering-minded indie hackers who already trust Reddit + HN for signal, and coordinate a launch-week push once the base is primed. The founder leans technical; the voice is calm, spec-like, and cites numbers over vibes. This arc assumes no existing channel presence and ramps cadence from education-first posts to coordinated launch-week comments, with a compound-growth phase afterwards that optimises for reply-to-ratio and subreddit depth instead of reach.',
  milestones: [
    {
      atDayOffset: 0,
      title: 'Baseline profile + subreddit shortlist',
      successMetric: 'Top-12 subreddits chosen; voice profile locked',
      phase: 'foundation' as const,
    },
    {
      atDayOffset: 7,
      title: 'First educational posts live',
      successMetric: '3 posts · 2+ comments each · 0 mod strikes',
      phase: 'audience' as const,
    },
    {
      atDayOffset: 21,
      title: 'Launch week',
      successMetric: 'Product Hunt Top 5 · HN front page',
      phase: 'launch' as const,
    },
  ],
  thesisArc: [
    {
      weekStart: '2026-04-20T00:00:00.000Z',
      theme: 'Week 1 — observation and voice calibration',
      angleMix: ['story', 'claim', 'howto'] as const,
    },
    {
      weekStart: '2026-04-27T00:00:00.000Z',
      theme: 'Week 2 — targeted replies in r/SaaS and r/indiehackers',
      angleMix: ['case', 'data'] as const,
    },
  ],
  contentPillars: [
    'Reddit discovery',
    'AI-assisted drafting',
    'Indie SaaS launch tactics',
  ],
  channelMix: {
    reddit: {
      perWeek: 4,
      preferredHours: [14, 18],
      preferredCommunities: ['SaaS', 'indiehackers'],
    },
    x: {
      perWeek: 6,
      preferredHours: [13, 19],
    },
  },
  phaseGoals: {
    foundation: 'Lock subreddit + voice before posting',
    audience: 'Build a recognisable handle in 3 communities',
    launch: 'Coordinated PH + HN push in week 3',
  },
};

const MOCK_TACTICAL_PLAN = {
  plan: {
    thesis: 'Build an audience on Reddit + X before a PH launch',
    notes:
      'Week 1 focuses on listening + calibration. By end of week 2, ShipFlare has a recognisable profile in r/SaaS and r/indiehackers, and Week 3 is a coordinated launch sprint.',
  },
  items: [
    {
      kind: 'setup_task' as const,
      userAction: 'manual' as const,
      phase: 'foundation' as const,
      channel: null,
      scheduledAt: '2026-04-20T14:00:00.000Z',
      skillName: null,
      params: {},
      title: 'Pick your top 5 subreddits',
      description: 'Lock the communities for the week.',
    },
    {
      kind: 'content_reply' as const,
      userAction: 'approve' as const,
      phase: 'audience' as const,
      channel: 'reddit',
      scheduledAt: '2026-04-21T18:00:00.000Z',
      skillName: 'reply-drafter',
      params: { subreddit: 'SaaS' },
      title: 'Reply to a thread in r/SaaS',
      description: 'Targeted reply in the top relevance bucket.',
    },
    {
      kind: 'content_post' as const,
      userAction: 'approve' as const,
      phase: 'audience' as const,
      channel: 'x',
      scheduledAt: '2026-04-22T13:00:00.000Z',
      skillName: 'content-batch',
      params: {},
      title: 'Post a spec-first thread on X',
      description: 'One post, anchored to the week-1 thesis.',
    },
  ],
};

/**
 * Intercept POST /api/onboarding/plan with a deterministic planner response.
 * Returns schema-valid strategic path + tactical plan so Stage 7 renders.
 */
export async function mockPlanSuccess(page: Page) {
  await page.route('**/api/onboarding/plan', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        path: MOCK_STRATEGIC_PATH,
        plan: MOCK_TACTICAL_PLAN,
      }),
    }),
  );
}

/**
 * Intercept POST /api/onboarding/plan with a hanging request that aborts
 * after the client's 45s timeout. Lets us exercise Stage 6's error state.
 *
 * To keep the test fast, we return 504 immediately rather than hanging —
 * the UI handles both paths identically.
 */
export async function mockPlanTimeout(page: Page) {
  await page.route('**/api/onboarding/plan', (route) =>
    route.fulfill({
      status: 504,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'planner_timeout' }),
    }),
  );
}

/**
 * Intercept POST /api/onboarding/commit with a successful write.
 * Bypasses the full DB transaction chain so tests don't depend on the
 * planner catalog, rate limiter, or BullMQ queue.
 */
export async function mockCommitSuccess(page: Page) {
  await page.route('**/api/onboarding/commit', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        productId: 'prod-mock-1',
        enqueued: [],
      }),
    }),
  );
}

/**
 * Mock /api/channels for Stage 4 + Stage 6 channel-list probe.
 * Call with an explicit platform list to simulate a connected account.
 */
export async function mockChannels(
  page: Page,
  platforms: Array<'reddit' | 'x' | 'email'> = [],
) {
  const channels = platforms.map((platform, i) => ({
    id: `chan-${i}`,
    platform,
    username: `test-${platform}`,
  }));
  await page.route('**/api/channels', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channels }),
    }),
  );
}

/**
 * Intercept POST /api/automation/run with a successful response.
 */
export async function mockAutomationRunSuccess(page: Page) {
  await page.route('**/api/automation/run', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        product: 'ShipFlare',
        subreddits: ['SideProject', 'startups', 'webdev'],
      }),
    }),
  );
}

/**
 * Intercept POST /api/automation/run with a 400 "no product" error.
 */
export async function mockAutomationRunNoProduct(page: Page) {
  await page.route('**/api/automation/run', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'No product configured. Complete onboarding first.',
      }),
    }),
  );
}

/**
 * Intercept POST /api/automation/run with a network failure.
 */
export async function mockAutomationRunNetworkError(page: Page) {
  await page.route('**/api/automation/run', (route) => route.abort());
}
