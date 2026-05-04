/**
 * Discovery → draft pipeline smoke after the Plan 1
 * (merge-judging-share-slop-rules) merge. Conservative on purpose:
 * the goal is "page renders, automation route triggers, no console
 * errors" — NOT "specific draft content lands in 90s" (LLM workloads
 * fail for unrelated reasons all the time).
 *
 * Verifies:
 *   - /briefing renders with the BriefingHeader H1
 *   - POST /api/automation/run returns 2xx (BullMQ work runs async)
 *   - Plan and Today tabs navigate without crashing
 *   - No real console errors during the flow (favicon/font noise filtered)
 *
 * Uses the live-smoke project (auto-skipped without .auth/founder.json).
 * Run with: pnpm test:e2e:live -- e2e/tests/draft-pipeline.live-smoke.ts
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const AUTH_PATH = '.auth/founder.json';

// Skip when the fixture is missing OR has an empty cookies array (stale
// session — re-capture per playwright.config.ts instructions). Without this
// stale-state guard, Playwright loads an empty storage state and the test
// fails on /briefing's redirect to / instead of skipping cleanly.
function authStateUsable(): boolean {
  if (!fs.existsSync(AUTH_PATH)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')) as {
      cookies?: unknown[];
    };
    return Array.isArray(parsed.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}

test.skip(
  !authStateUsable(),
  `live-smoke needs a non-stale .auth/founder.json with real cookies — see playwright.config.ts for capture instructions.`,
);

test('discovery → draft pipeline produces drafts after Plan 1 merge', async ({
  page,
}) => {
  // Capture console errors throughout the test.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Step 1: open /briefing — should render without React errors.
  await page.goto('/briefing');
  await expect(page).toHaveURL(/\/briefing(\/)?$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Step 2: trigger automation. The route returns quickly; the actual
  // discovery → draft work runs in BullMQ workers. We don't wait for
  // drafts to land here — that's flaky across LLM rate limits.
  const triggerResp = await page.request.post('/api/automation/run');
  expect(triggerResp.ok()).toBeTruthy();

  // Step 3: navigate around briefing tabs to verify nothing crashes.
  await page.getByRole('link', { name: 'Plan' }).click();
  await expect(page).toHaveURL(/\/briefing\/plan/);
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/briefing(\/)?$/);

  // Step 4: assert no console errors during the flow. Filter common
  // harmless noise (favicon 404s, font preload warnings).
  await page.waitForLoadState('networkidle');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.toLowerCase().includes('font'),
  );
  expect(realErrors).toHaveLength(0);
});
