/**
 * Social Media Manager collapse smoke (Plan 3).
 *
 * Verifies the post-Plan-3 surface area:
 *   - /team page shows "Social Media Manager" (the collapsed agent)
 *   - /team page does NOT show the deleted agent names (content-manager,
 *     content-planner, discovery-agent) — guard against regressions in
 *     team-presets / team-provisioner / agent-accent
 *   - landing page (/) hero + agents grid shows the real industry titles
 *     ("Social Media Manager", "Chief Marketing Officer") instead of the
 *     all-caps shorthand (CMO, SOCIAL, etc.)
 *   - /briefing renders without console errors after triggering automation
 *
 * Skips when .auth/founder.json is missing OR has empty cookies (stale).
 * Run with: pnpm test:e2e:live -- e2e/tests/social-media-manager.live-smoke.ts
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const AUTH_PATH = '.auth/founder.json';

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

test('Plan 3 collapse — Social Media Manager visible everywhere, deleted agents nowhere', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // ── /team page ──
  await page.goto('/team');
  await expect(page.getByText('Social Media Manager').first()).toBeVisible({
    timeout: 10_000,
  });
  // Coordinator (CMO) is unchanged — also visible.
  await expect(page.getByText(/coordinator|Chief Marketing Officer/i).first()).toBeVisible();
  // Deleted agents must NOT appear.
  await expect(page.getByText('content-manager')).toHaveCount(0);
  await expect(page.getByText('content-planner')).toHaveCount(0);
  await expect(page.getByText('discovery-agent')).toHaveCount(0);

  // ── landing page (/) ──
  await page.goto('/');
  await expect(page.getByText('Social Media Manager').first()).toBeVisible();
  await expect(page.getByText('Chief Marketing Officer').first()).toBeVisible();

  // ── trigger automation, confirm /briefing renders cleanly ──
  const triggerResp = await page.request.post('/api/automation/run');
  expect(triggerResp.ok()).toBeTruthy();

  await page.goto('/briefing');
  await expect(page).toHaveURL(/\/briefing(\/)?$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.waitForLoadState('networkidle');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.toLowerCase().includes('font'),
  );
  expect(realErrors).toHaveLength(0);
});
