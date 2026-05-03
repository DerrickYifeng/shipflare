/**
 * Phase 2 — team chat delegation live smoke.
 *
 * Catches today's afternoon bug class: `team_tasks.run_id` FK violation
 * when the lead's Task tool fires (commit `5ca8887` fixed by dropping
 * the dead team_runs FK + restoring runId writes).
 *
 * Workflow:
 *   1. Send a message that should provoke the lead to delegate via
 *      Task to a teammate.
 *   2. Verify a teammate row appears in the roster (left sidebar).
 *   3. Verify the teammate transitions to a terminal status within
 *      timeout (no infinite "running" stuck on FK error).
 *   4. Verify a task_notification arrives back at the lead's chat.
 *   5. Verify NO `Tool Task failed` / `Failed query` errors in
 *      console.
 *
 * Run:
 *   pnpm test:e2e:live -- e2e/tests/team-delegation.live-smoke.ts
 *
 * Cost: ~$0.10-0.30 LLM (lead + spawned teammate both run real
 * round-trips).
 */

import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test.skip(
  !fs.existsSync('.auth/founder.json'),
  'Run setup section A (capture .auth/founder.json via `pnpm playwright codegen --save-storage=.auth/founder.json`) before running live-smoke specs',
);

test.describe.configure({ mode: 'serial' });

test('[smoke] lead delegates via Task without team_tasks FK crash', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/team');
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });

  // ----- Snapshot the roster row count BEFORE delegation -----
  // We'll assert it grew by at least 1 by the end (a teammate spawned).
  // Use a generous selector since the roster's exact DOM shape may evolve.
  const rosterRowsBefore = await page
    .locator('[data-roster-row], [data-teammate-id], .roster-row')
    .count()
    .catch(() => 0);

  // ----- Send a message that should provoke delegation -----
  const composer = page
    .getByPlaceholder(/send a message|message your team|ask|type/i)
    .or(page.getByRole('textbox').first())
    .first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  await composer.fill(
    "[smoke] Please draft 2 short X posts about our product launch using my current strategic path. I'll review them shortly.",
  );
  await composer.press('Enter');
  const sendButton = page.getByRole('button', { name: /send|submit/i }).first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click().catch(() => undefined);
  }

  // ----- Wait for a Task tool-call card to appear -----
  // The lead delegates to content-manager (or similar) via Task. The
  // activity card renders 'Task' as the tool name.
  await expect(page.getByText(/^Task$|task tool/i).first()).toBeVisible({
    timeout: 90_000,
  });

  // ----- Wait for the roster to grow (teammate spawned) -----
  // Poll for ~30s; pass if the count ever exceeds the baseline.
  await expect
    .poll(
      async () =>
        page
          .locator('[data-roster-row], [data-teammate-id], .roster-row')
          .count()
          .catch(() => 0),
      { timeout: 60_000, intervals: [2_000, 5_000] },
    )
    .toBeGreaterThan(rosterRowsBefore);

  // ----- Wait for the teammate to reach a terminal state -----
  // Look for a "completed" status pill or a task_notification card in
  // the chat thread. Generous timeout (3min) — content-manager's full
  // judging+drafting+validating pipeline can take 90s+.
  await expect
    .poll(
      async () => {
        const text = await page.locator('body').innerText();
        return /completed|done|task.notification|drafted|finished/i.test(text);
      },
      { timeout: 180_000, intervals: [5_000, 10_000] },
    )
    .toBeTruthy();

  // ----- Anti-regression: no Task FK / query failures in console -----
  const failures = consoleErrors.filter((e) =>
    /Tool Task failed|Failed query|team_tasks.*run_id|FK violation|Missing dependency/i.test(
      e,
    ),
  );
  expect(failures, `console errors: ${failures.join('\n')}`).toHaveLength(0);
});
