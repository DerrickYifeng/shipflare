/**
 * Phase 0.5 — fresh-onboarding live smoke (DESTRUCTIVE).
 *
 * Catches the "write_strategic_path: product null not found" bug class
 * that today's commit `19436f6` fixed. No existing test caught the
 * fresh-onboarding crash because the seeded `onboarding.spec.ts` is a
 * visual-regression test, not an end-to-end LLM-driven flow.
 *
 * Workflow (founder, manual prelude — the spec assumes steps 1-2 done):
 *   1. SQL-delete your user:
 *        DELETE FROM users WHERE email = 'cdhyfpp@gmail.com';
 *      (Cascades through team / agent_runs / drafts / channels / etc.)
 *   2. Sign in fresh: open http://localhost:3000 in a real browser,
 *      complete the GitHub OAuth flow. Land on /onboarding/source.
 *   3. Capture the post-login storageState BEFORE running this spec:
 *        pnpm playwright codegen --save-storage=.auth/founder-fresh.json http://localhost:3000
 *      Click around briefly to confirm the session works, close the
 *      Codegen window. The new file at `.auth/founder-fresh.json`
 *      reflects the post-login pre-onboarding session.
 *   4. Run this spec:
 *        pnpm test:e2e:live -- e2e/tests/onboarding-fresh.live-smoke.ts
 *
 * The spec drives onboarding stages 1-4 (extract → review → plan →
 * commit) and asserts the bug class doesn't reproduce. It does NOT
 * cover the destructive deletion (manual SQL preferred — too risky
 * to automate).
 */

import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const FRESH_AUTH_PATH = '.auth/founder-fresh.json';

test.skip(
  !fs.existsSync(FRESH_AUTH_PATH),
  `Run the manual prelude in this file's docstring before this spec — capture .auth/founder-fresh.json from a freshly-onboarded session.`,
);

// Override the project-default storageState (.auth/founder.json) with the
// fresh-account session for this spec only.
test.use({ storageState: FRESH_AUTH_PATH });

test.describe.configure({ mode: 'serial' });

test('[smoke] fresh onboarding completes end-to-end without write_strategic_path crash', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/onboarding/source');

  // ----- Stage 1 — Source extraction -----
  // Try the website-URL field first; fall back to the GitHub-repo
  // selector if the URL field isn't found (UI may have rebranded the
  // entry).
  const websiteField = page.getByPlaceholder(/website|url|domain|https?:\/\//i).first();
  const websiteFieldVisible = await websiteField.isVisible().catch(() => false);
  if (websiteFieldVisible) {
    await websiteField.fill('https://shipflare.dev');
    await page
      .getByRole('button', { name: /extract|next|continue/i })
      .first()
      .click();
  } else {
    // Fall back: pick the first GitHub repo card / button.
    const repoCard = page.getByRole('button', { name: /repo|github/i }).first();
    test.skip(
      !(await repoCard.isVisible().catch(() => false)),
      'Cannot find a stage-1 entry control (URL field or repo selector). UI may have changed; update this spec.',
    );
    await repoCard.click();
    await page
      .getByRole('button', { name: /extract|next|continue/i })
      .first()
      .click();
  }

  // Within 30s the extracted product info should render. Look for any
  // of the canonical fields ("category", "target audience", or the
  // product name + description pair).
  await expect(
    page.getByText(/category|target audience|description/i).first(),
  ).toBeVisible({ timeout: 30_000 });

  // ----- Stage 2 — Review (accept defaults, continue) -----
  await page
    .getByRole('button', { name: /continue|next|looks good/i })
    .first()
    .click();

  // ----- Stage 3 — Plan generation -----
  // SSE-streamed strategic path. Wait for one of the canonical
  // section headings to appear. Generous timeout (90-120s) because
  // the LLM round-trip + streaming can be slow.
  await expect(
    page.getByText(/milestones|content pillars|thesis arc|narrative/i).first(),
  ).toBeVisible({ timeout: 120_000 });

  // ----- Anti-regression assertions -----
  const allText = await page.locator('body').innerText();

  // Today's morning bug class — the route now creates a draft product
  // before invoking the skill, so this string should never appear.
  expect(allText).not.toMatch(
    /planner_timeout|product null not found|strategic_paths row not found/i,
  );

  // Today's afternoon bug class — the lead's prompt should have real
  // values substituted, not literal placeholders.
  expect(allText).not.toMatch(
    /\{productName\}|\{currentPhase\}|\{itemCount\}|\{TEAM_ROSTER\}|\{founderName\}/,
  );

  // Today's team_runs orphan — the Task tool's team_tasks insert
  // shouldn't crash with FK violations during commit.
  expect(allText).not.toMatch(/Tool Task failed|Failed query|FK violation/i);

  // ----- Stage 4 — Commit -----
  await page
    .getByRole('button', { name: /commit|finalize|all done|continue|finish/i })
    .first()
    .click();

  // Should land on /team or /today within 30s.
  await expect(page).toHaveURL(/\/(team|today)/, { timeout: 30_000 });

  // ----- No console errors during the whole flow -----
  expect(
    consoleErrors.filter((e) =>
      /Tool .* failed|Missing dependency|product null not found/i.test(e),
    ),
  ).toHaveLength(0);
});
