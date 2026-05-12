/**
 * Reddit subreddit research → /today Post → Reddit submit URL handoff.
 *
 * Live-smoke test running against the founder's actual dev server +
 * authenticated session + real xAI research call. Skipped automatically
 * when .auth/founder.json doesn't exist so the seeded suite stays green
 * for contributors.
 *
 * Coverage:
 * 1. /onboarding/research shows the top-3 subreddits within 60s (or
 *    immediately if research already ran for this product).
 * 2. /today eventually surfaces a Reddit content_post card with a
 *    subreddit visible on the card.
 * 3. Clicking Post opens a new tab on https://www.reddit.com/r/<sub>/submit
 *    pre-filled with title + selftext.
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const AUTH_STATE = '.auth/founder.json';

test.skip(
  () => !fs.existsSync(AUTH_STATE),
  'live-smoke requires .auth/founder.json — see playwright.config.ts',
);

test.use({ storageState: AUTH_STATE });

test('founder sees top-3 subreddits in onboarding and posts to Reddit submit URL', async ({
  page,
  context,
}) => {
  // 1. Visit onboarding research
  await page.goto('/onboarding/research');

  // Wait for at least one channel row (research may already be done from a
  // prior run; either way 60s is a comfortable upper bound).
  const firstRow = page.locator('[data-testid="reddit-channel-row"]').first();
  await expect(firstRow).toBeVisible({ timeout: 60_000 });

  // Expect 3 rows in steady state. If research is mid-flight, the count
  // may climb from 1→3 — poll on the final count instead of a single
  // toBeVisible().
  await expect
    .poll(
      async () => page.locator('[data-testid="reddit-channel-row"]').count(),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(3);

  // 2. Visit /today — kickoff should have already produced reddit content_post
  // drafts via the sweeper after /onboarding/commit fired. If a Reddit card
  // isn't present yet, wait up to 60s.
  await page.goto('/today');

  const redditCard = page
    .locator('[data-testid="post-card"][data-channel="reddit"]')
    .first();
  await expect(redditCard).toBeVisible({ timeout: 60_000 });

  // Subreddit is shown on the card (e.g. "r/SaaS"). Lenient match.
  await expect(redditCard.getByText(/r\/[A-Za-z0-9_]+/).first()).toBeVisible();

  // 3. Click Post — assert a new tab opens to reddit.com/r/<sub>/submit
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    redditCard.getByRole('button', { name: /post/i }).click(),
  ]);
  expect(popup.url()).toMatch(
    /^https:\/\/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/submit\?/,
  );
  expect(popup.url()).toContain('type=text');
  expect(popup.url()).toContain('title=');
  expect(popup.url()).toContain('selftext=');

  await popup.close();
});

test('Reddit content_post without subreddit shows inline picker, not 500', async ({
  page,
}) => {
  // This case is harder to set up without a DB seed harness — we'd need
  // a Reddit content_post in /today whose params lacks subreddit. After
  // the Task 5 gate landed, the only way that happens is a legacy row.
  // Skip if we can't surface one in 5s.
  await page.goto('/today');

  const pickerExists = await page
    .locator(
      '[data-testid="post-card"][data-channel="reddit"] [data-testid="subreddit-picker"]',
    )
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  test.skip(
    !pickerExists,
    'No legacy Reddit content_post without subreddit on the current /today feed; safety net path not exercised. Run drop-stuck-content-post.sql then re-plan and re-trigger to test.',
  );

  const picker = page.locator('[data-testid="subreddit-picker"]').first();
  await picker.locator('select').selectOption({ index: 0 });
  await page.getByRole('button', { name: /apply/i }).click();
  await expect(page.getByRole('button', { name: /post/i })).toBeVisible();
});
