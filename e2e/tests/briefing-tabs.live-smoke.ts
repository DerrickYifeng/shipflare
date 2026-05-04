/**
 * Briefing route + redirect smoke. Asserts:
 *   - /briefing renders with the BriefingHeader title and Today tab active
 *   - clicking Plan navigates to /briefing/plan and the calendar grid renders
 *   - direct visits to /today and /calendar 301-redirect into /briefing
 *   - ?weekStart on /calendar survives the redirect
 *
 * Uses the live-smoke project (auto-skipped without .auth/founder.json).
 * Run with: pnpm test:e2e:live -- e2e/tests/briefing-tabs.live-smoke.ts
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const AUTH_PATH = '.auth/founder.json';
test.skip(
  !fs.existsSync(AUTH_PATH),
  `live-smoke needs .auth/founder.json — see e2e/README.md for capture instructions.`,
);

test('briefing tabs + legacy route redirects', async ({ page }) => {
  await page.goto('/briefing');
  await expect(page).toHaveURL(/\/briefing(\/)?$/);

  // Header renders the boss-frame H1 (any of the three branches works).
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();

  // Today tab is active.
  const todayLink = page.getByRole('link', { name: 'Today' });
  await expect(todayLink).toHaveAttribute('aria-current', 'page');

  // Click Plan tab.
  await page.getByRole('link', { name: 'Plan' }).click();
  await expect(page).toHaveURL(/\/briefing\/plan/);
  const planLink = page.getByRole('link', { name: 'Plan' });
  await expect(planLink).toHaveAttribute('aria-current', 'page');

  // Calendar week grid renders something — minimum: a visible day label.
  // Loose assertion intentionally; existing /calendar visual tests cover layout.
  await expect(page.locator('body')).toContainText(/Mon|Tue|Wed|Thu|Fri/);

  // Legacy redirects.
  await page.goto('/today');
  await expect(page).toHaveURL(/\/briefing(\/)?$/);

  await page.goto('/calendar?weekStart=2026-05-04');
  await expect(page).toHaveURL(/\/briefing\/plan\?weekStart=2026-05-04/);
});
