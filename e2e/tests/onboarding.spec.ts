// v3 onboarding E2E — 4 visible steps, 7 stages under the hood.
//
// Coverage: happy URL path end-to-end, extract fallback, planner timeout
// fallback, back-preserves-state, Redis-draft resume, and mobile viewport.
// Everything downstream of Stage 2 is mocked because the real chain runs
// two LLM calls (planner) + DB writes + BullMQ enqueues that aren't E2E-
// deterministic.

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../fixtures/auth';
import {
  mockExtractSuccess,
  mockExtractFailure,
  mockExtractRepoSuccess,
  mockGithubReposSuccess,
  mockPlanSuccess,
  mockPlanTimeout,
  mockCommitSuccess,
  mockChannels,
  captureCommitBody,
} from '../helpers/intercepts';

// Visual-regression shot. Delegates to Playwright's `toHaveScreenshot`,
// which diffs against `e2e/screenshots/onboarding.spec.ts/baseline/<name>.png`
// (path configured via snapshotPathTemplate in playwright.config.ts).
// First run generates the baseline; subsequent runs fail the test if
// >1% of pixels drift (see expect.toHaveScreenshot in the config).
//
// To intentionally update baselines after a visual change, run
// `bun run test:e2e:visual:update` (or any `playwright test
// --update-snapshots` invocation) and commit the new PNGs.
async function shot(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`);
}

/**
 * Stub all three API boundaries the onboarding flow touches so a single
 * test can drive the 7 stages without hitting LLMs or the DB.
 */
async function stubOnboardingChain(
  page: Page,
  options: { connectedChannels?: Array<'reddit' | 'x' | 'email'> } = {},
) {
  await mockExtractSuccess(page);
  await mockPlanSuccess(page);
  await mockCommitSuccess(page);
  await mockChannels(page, options.connectedChannels ?? []);
  await page.route('**/api/onboarding/github-repos', (route: Route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No GitHub account linked' }),
    }),
  );
}

// Stage 1 source picker has two method cards (<button>s with the method
// title as inner text).
async function pickUrlMethod(page: Page) {
  await page.getByRole('button', { name: /From website URL/ }).click();
}

// Stage 3 Product name textbox — identified by placeholder since the
// `<label>` isn't associated with an input id. (A11y finding for Phase 15.)
function productNameInput(page: Page) {
  return page.getByRole('textbox', { name: 'ShipFlare', exact: true });
}

test.describe('Onboarding v3: desktop happy URL path', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  // The six-step animator runs twice (Stage 2 scan + Stage 6 plan build)
  // at ~850ms/step. Stack that on top of React mount and the 30s default
  // test timeout isn't enough.
  test.setTimeout(90_000);

  test('completes all 7 stages and lands on /today', async ({
    authenticatedPage: page,
  }) => {
    await stubOnboardingChain(page);
    await page.goto('/onboarding');

    // -- Stage 1 (source) --
    await expect(page.getByRole('heading', { name: 'Add your product', level: 2 })).toBeVisible();
    await shot(page, 'stage1-source-desktop');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();

    // -- Stage 2 (scanning) → Stage 3 (review) --
    // Six-step animator runs ~5-8s. Wait for Stage 3's heading AND the
    // staggered reveal to fully settle before snapping.
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/What happens next:/)).toBeVisible();
    await shot(page, 'stage3-review-desktop');

    // Name input is pre-filled from extract mock. The placeholder is also
    // "ShipFlare" but placeholder-derived accessible name is skipped when
    // a value is present in Playwright's ARIA snapshot, so match by value.
    await expect(productNameInput(page)).toHaveValue('ShipFlare');
    await page
      .getByRole('button', { name: /Looks good, continue/i })
      .click();

    // -- Stage 4 (connect) -- skip for now.
    await expect(
      page.getByRole('heading', { level: 2, name: /Connect your accounts/i }),
    ).toBeVisible();
    await shot(page, 'stage4-connect-desktop');
    await page.getByRole('button', { name: /Skip for now/i }).click();

    // -- Stage 5 (state) --
    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();
    await shot(page, 'stage5-state-desktop');

    // Wait for the plan mock to be consumed — avoids a known race where
    // `connectedChannels` refresh in OnboardingFlow creates a new array and
    // reruns StagePlanBuilding's effect, aborting the real-call controller
    // and surfacing a spurious "taking longer than expected" error.
    const planResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/plan') && res.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /Generate plan/i }).click();
    await planResponse;

    // -- Stage 6 → Stage 7 --
    await expect(
      page.getByRole('heading', { level: 2, name: /Your launch plan/i }),
    ).toBeVisible({ timeout: 25_000 });
    await shot(page, 'stage7-plan-desktop');

    await page.getByRole('button', { name: /Launch the agents/i }).click();
    await page.waitForURL('**/today?from=onboarding', { timeout: 15_000 });
  });
});

test.describe('Onboarding v3: error + fallback paths', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test('extract failure bounces back to Stage 1 URL form; manual-entry escape works', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractFailure(page);
    await mockChannels(page, []);
    await page.goto('/onboarding');

    await pickUrlMethod(page);
    await page
      .getByPlaceholder('https://your-product.com')
      .fill('https://bad-url.invalid');
    await page.getByRole('button', { name: /Scan website/i }).click();

    // Extract fails → animator shows error → bounces to Stage 1 URL form
    // after ~900ms with the URL preserved.
    await expect(
      page.getByPlaceholder('https://your-product.com'),
    ).toHaveValue('https://bad-url.invalid', { timeout: 15_000 });

    // Escape via "Pick a different method" → "or enter manually".
    await page
      .getByRole('button', { name: /Pick a different method/i })
      .first()
      .click();
    await page.getByRole('button', { name: /or enter manually/i }).click();

    // Stage 3 opens with empty values.
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible();
    await expect(productNameInput(page)).toHaveValue('');
  });

  test('planner 504 surfaces "Continue with manual plan" fallback', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractSuccess(page);
    await mockPlanTimeout(page);
    await mockChannels(page, []);
    await page.goto('/onboarding');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Looks good, continue/i }).click();
    await page.getByRole('button', { name: /Skip for now/i }).click();
    await page.getByRole('button', { name: /Generate plan/i }).click();

    await expect(
      page.getByRole('button', { name: /Continue with manual plan/i }),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, 'stage6-plan-building-error-desktop');

    await page
      .getByRole('button', { name: /Continue with manual plan/i })
      .click();

    // Fallback lands us back on Stage 5.
    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();
  });

  test('Back from Stage 5 returns to Stage 4 with state preserved', async ({
    authenticatedPage: page,
  }) => {
    await stubOnboardingChain(page);
    await page.goto('/onboarding');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Looks good, continue/i }).click();
    await page.getByRole('button', { name: /Skip for now/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();

    // Pick "I'm already live" to reveal the users-bucket sub-form.
    await page.getByText(/I'm already live/i).click();
    await page.getByRole('button', { name: '100–1k' }).click();
    await expect(page.getByText(/Roughly how many users\?/i)).toBeVisible();

    // Go back to Stage 4 via the ActionBar Back (uses name "Back"). The
    // desktop TopChevron is also labeled "Back"; both work — `.last()`
    // grabs the one inside the panel.
    await page.getByRole('button', { name: 'Back', exact: true }).last().click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Connect your accounts/i }),
    ).toBeVisible();

    // Forward again; state stays "launched" so users-bucket form is visible.
    await page.getByRole('button', { name: /Skip for now/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();
    await expect(page.getByText(/Roughly how many users\?/i)).toBeVisible();
  });
});

test.describe('Onboarding v3: Redis draft resume', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test('reloading after Stage 3 edit resumes with profile intact', async ({
    authenticatedPage: page,
  }) => {
    await stubOnboardingChain(page);
    await page.goto('/onboarding');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });

    // Edit name so the debounced autosave writes to Redis, then wait
    // for 400ms debounce + a PUT round-trip.
    const name = productNameInput(page);
    await name.fill('Resumed ShipFlare');
    // The autosave debounces 400ms and then PUTs /api/onboarding/draft.
    // Wait for that request specifically so we don't race the reload.
    await page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/draft') && res.request().method() === 'PUT',
      { timeout: 5_000 },
    );

    await page.reload();
    // On reload the draft hydration runs; we should land on Stage 3 (review)
    // with the edited name intact.
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(productNameInput(page)).toHaveValue('Resumed ShipFlare', {
      timeout: 10_000,
    });
  });
});

test.describe('Onboarding v3: mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test.setTimeout(90_000);

  test('happy path completes on 375px; mobile chrome works', async ({
    authenticatedPage: page,
  }) => {
    await stubOnboardingChain(page);
    await page.goto('/onboarding');

    await expect(page.getByRole('heading', { name: 'Add your product', level: 2 })).toBeVisible();
    await shot(page, 'stage1-source-mobile');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();

    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    // Stage 3 reveals 6 fields staggered at 90ms intervals; the "What
    // happens next" block appears last. Wait for it before snapping so
    // the baseline vs actual diff isn't driven by stagger timing.
    await expect(page.getByText(/What happens next:/)).toBeVisible();
    await shot(page, 'stage3-review-mobile');
    await page.getByRole('button', { name: /Looks good, continue/i }).click();

    await expect(
      page.getByRole('heading', { level: 2, name: /Connect your accounts/i }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Skip for now/i }).click();

    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();
    await shot(page, 'stage5-state-mobile');

    const planResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/plan') && res.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /Generate plan/i }).click();
    await planResponse;

    await expect(
      page.getByRole('heading', { level: 2, name: /Your launch plan/i }),
    ).toBeVisible({ timeout: 25_000 });
    await shot(page, 'stage7-plan-mobile');

    await page.getByRole('button', { name: /Launch the agents/i }).click();
    await page.waitForURL('**/today?from=onboarding', { timeout: 15_000 });
  });
});

test.describe('Onboarding v3: accessibility', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(60_000);

  test('prefers-reduced-motion clamps the six-step animator', async ({
    authenticatedPage: page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubOnboardingChain(page);
    await page.goto('/onboarding');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    const scanStart = Date.now();
    await page.getByRole('button', { name: /Scan website/i }).click();

    // With reduced motion, SixStepAnimator's per-step delay collapses from
    // ~850ms+jitter to 50ms. Six steps × 50ms + extract mock + 400ms
    // completion pause = ~1s total. If it takes >4s, reduced-motion is
    // being ignored.
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 6_000 });
    const elapsed = Date.now() - scanStart;
    expect(elapsed).toBeLessThan(4_000);
  });

  test('state picker exposes role=radiogroup', async ({
    authenticatedPage: page,
  }) => {
    await stubOnboardingChain(page);
    await page.goto('/onboarding');

    await pickUrlMethod(page);
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Looks good, continue/i }).click();
    await page.getByRole('button', { name: /Skip for now/i }).click();

    await expect(
      page.getByRole('radiogroup', { name: /Where's your product at\?/i }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// v3 onboarding — widened coverage per gap-audit MEDIUM #18.
//
// The tests above only exercise the URL extract path. These cover:
//   - GitHub source (mocked /api/onboarding/github-repos + SSE extract-repo)
//   - category picker interaction (commit payload carries `saas`)
//   - state='launched' path (launchedAt date picker + commit payload)
//   - state='mvp' path (no date, commit payload has both launchDate +
//     launchedAt null)
//
// `captureCommitBody` is the glue: it wraps `mockCommitSuccess` and exposes
// the POSTed body to the test so we can assert payload shape without
// touching Zod-strictness-sensitive backend behavior.
// ---------------------------------------------------------------------------

test.describe('Onboarding v3: GitHub source path', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test('completes via GitHub repo picker', async ({
    authenticatedPage: page,
  }) => {
    await mockGithubReposSuccess(page);
    await mockExtractRepoSuccess(page);
    await mockPlanSuccess(page);
    await mockCommitSuccess(page);
    await mockChannels(page, []);

    await page.goto('/onboarding');

    // -- Stage 1 (source) — pick GitHub tile --
    await page.getByRole('button', { name: /Import from GitHub/i }).click();

    // The GitHub repo list renders after /api/onboarding/github-repos resolves.
    // Pick the first repo.
    await expect(page.getByText(/test-user\/shipflare/)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByText(/test-user\/shipflare/).click();
    await page.getByRole('button', { name: /Scan repository/i }).click();

    // -- Stage 2 → 3 — SSE extract-repo completes, review loads --
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await expect(productNameInput(page)).toHaveValue('ShipFlare');
    await page
      .getByRole('button', { name: /Looks good, continue/i })
      .click();

    // -- Stage 4 → 5 — skip channel, launching default --
    await page.getByRole('button', { name: /Skip for now/i }).click();

    const planResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/plan') && res.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /Generate plan/i }).click();
    await planResponse;

    // -- Stage 6 → 7 → commit --
    await expect(
      page.getByRole('heading', { level: 2, name: /Your launch plan/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Launch the agents/i }).click();
    await page.waitForURL('**/today?from=onboarding', { timeout: 15_000 });
  });
});

test.describe('Onboarding v3: category picker', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test('selecting SaaS propagates to commit body', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractSuccess(page);
    await mockPlanSuccess(page);
    await mockChannels(page, []);
    const commit = await captureCommitBody(page);
    await page.route('**/api/onboarding/github-repos', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No GitHub account linked' }),
      }),
    );

    await page.goto('/onboarding');
    await pickUrlMethod(page);
    await page
      .getByPlaceholder('https://your-product.com')
      .fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();

    // Stage 3 — switch category to SaaS explicitly.
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    const categoryGroup = page.getByRole('radiogroup', {
      name: /Product category/i,
    });
    await expect(categoryGroup).toBeVisible();
    await categoryGroup.getByRole('radio', { name: 'SaaS', exact: true }).click();
    await page.getByRole('button', { name: /Looks good, continue/i }).click();

    // Skip through to commit.
    await page.getByRole('button', { name: /Skip for now/i }).click();
    const planResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/plan') && res.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /Generate plan/i }).click();
    await planResponse;
    await expect(
      page.getByRole('heading', { level: 2, name: /Your launch plan/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Launch the agents/i }).click();
    await page.waitForURL('**/today?from=onboarding', { timeout: 15_000 });

    const body = commit.latest();
    expect(body).not.toBeNull();
    const product = (body as { product?: { category?: string } } | null)
      ?.product;
    expect(product?.category).toBe('saas');
  });
});

test.describe("Onboarding v3: state='launched' path", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test('launched state collects launchedAt and commits', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractSuccess(page);
    await mockPlanSuccess(page);
    await mockChannels(page, []);
    const commit = await captureCommitBody(page);
    await page.route('**/api/onboarding/github-repos', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No GitHub account linked' }),
      }),
    );

    await page.goto('/onboarding');
    await pickUrlMethod(page);
    await page
      .getByPlaceholder('https://your-product.com')
      .fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Looks good, continue/i }).click();
    await page.getByRole('button', { name: /Skip for now/i }).click();

    // Stage 5 — pick "I'm already live" to reveal launched sub-form.
    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();
    await page.getByText(/I'm already live/i).click();

    // The launched sub-form reveals a "When did you launch?" date input +
    // users bucket. Date picker defaults to today; set it explicitly to
    // verify the field is plumbed.
    await expect(page.getByText(/When did you launch\?/i)).toBeVisible();
    const launchedDate = page.locator('input[type="date"]');
    await launchedDate.fill('2025-10-01');
    await page.getByRole('button', { name: '100–1k' }).click();

    const planResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/plan') && res.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /Generate plan/i }).click();
    await planResponse;
    await expect(
      page.getByRole('heading', { level: 2, name: /Your launch plan/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Launch the agents/i }).click();
    await page.waitForURL('**/today?from=onboarding', { timeout: 15_000 });

    const body = commit.latest() as {
      state?: string;
      launchedAt?: string | null;
      launchDate?: string | null;
    } | null;
    expect(body).not.toBeNull();
    expect(body?.state).toBe('launched');
    expect(body?.launchDate).toBeNull();
    expect(body?.launchedAt).toMatch(/^2025-10-01T/);
  });
});

test.describe("Onboarding v3: state='mvp' path", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(90_000);

  test('mvp state requires no dates and commits cleanly', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractSuccess(page);
    await mockPlanSuccess(page);
    await mockChannels(page, []);
    const commit = await captureCommitBody(page);
    await page.route('**/api/onboarding/github-repos', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No GitHub account linked' }),
      }),
    );

    await page.goto('/onboarding');
    await pickUrlMethod(page);
    await page
      .getByPlaceholder('https://your-product.com')
      .fill('https://shipflare.dev');
    await page.getByRole('button', { name: /Scan website/i }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: /Here's what we found/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Looks good, continue/i }).click();
    await page.getByRole('button', { name: /Skip for now/i }).click();

    // Stage 5 — pick "I'm still building".
    await expect(
      page.getByRole('heading', { level: 2, name: /Where's your product at\?/i }),
    ).toBeVisible();
    await page.getByText(/I'm still building\./i).click();
    // mvp state renders NO conditional sub-form — no date required.
    await expect(page.getByText(/When did you launch\?/i)).toHaveCount(0);
    await expect(page.getByText(/Launch details/i)).toHaveCount(0);

    const planResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/onboarding/plan') && res.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByRole('button', { name: /Generate plan/i }).click();
    await planResponse;
    await expect(
      page.getByRole('heading', { level: 2, name: /Your launch plan/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.getByRole('button', { name: /Launch the agents/i }).click();
    await page.waitForURL('**/today?from=onboarding', { timeout: 15_000 });

    const body = commit.latest() as {
      state?: string;
      launchDate?: string | null;
      launchedAt?: string | null;
    } | null;
    expect(body).not.toBeNull();
    expect(body?.state).toBe('mvp');
    expect(body?.launchDate).toBeNull();
    expect(body?.launchedAt).toBeNull();
  });
});
