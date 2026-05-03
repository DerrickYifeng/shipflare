/**
 * Phase 1 — team chat first-message live smoke.
 *
 * Catches the lead-tool-context regression class:
 *   - lead doesn't see literal {productName} / {currentPhase} placeholders
 *   - lead's domain tools (query_strategic_path, query_plan_items, etc.)
 *     succeed instead of throwing "Missing dependency: userId"
 *   - lead's tool-call activity cards render in the founder UI
 *
 * All three failure modes shipped in production at one point today
 * (commits 0750a35 / 8da3146 / 018f885 fix them respectively). This
 * spec is the regression smoke for the whole class.
 *
 * Run:
 *   pnpm test:e2e:live -- e2e/tests/team-chat.live-smoke.ts
 *
 * Cost: ~$0.05-0.15 LLM (one real round-trip with the lead).
 */

import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test.skip(
  !fs.existsSync('.auth/founder.json'),
  'Run setup section A (capture .auth/founder.json via `pnpm playwright codegen --save-storage=.auth/founder.json`) before running live-smoke specs',
);

test.describe.configure({ mode: 'serial' });

test('[smoke] lead chat — first message produces grounded response with tool cards', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/team');

  // Roster panel + composer should be visible within ~10s.
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });

  // Find the message composer. Try several common selectors so we don't
  // break if a label changes.
  const composer = page
    .getByPlaceholder(/send a message|message your team|ask|type/i)
    .or(page.getByRole('textbox').first())
    .first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  await composer.fill(
    "[smoke] What's my current strategic phase and how many plan items are scheduled this week? Be concise.",
  );

  // Submit — try Enter first, fall back to a Send button.
  await composer.press('Enter');
  // Some composers swallow Enter; press a button if one is visible.
  const sendButton = page.getByRole('button', { name: /send|submit/i }).first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click().catch(() => undefined);
  }

  // ----- Wait for at least one tool-call activity card -----
  // Tool names from the coordinator's allowlist (see
  // src/tools/AgentTool/agents/coordinator/AGENT.md). The activity
  // card renders the tool name; a substring match is enough.
  await expect(
    page.getByText(/query_strategic_path|query_plan_items|query_team_status/i).first(),
  ).toBeVisible({ timeout: 60_000 });

  // ----- Wait for the lead's text response to settle -----
  // Heuristic: poll the page text for ~30s after the tool card lands;
  // the lead's response usually arrives within 15-25s of the first
  // tool call.
  await page.waitForTimeout(30_000);

  const allText = await page.locator('body').innerText();

  // ----- Anti-regression: no literal placeholders in the response -----
  expect(allText).not.toMatch(
    /\{productName\}|\{productDescription\}|\{currentPhase\}|\{itemCount\}|\{statusBreakdown\}|\{TEAM_ROSTER\}|\{founderName\}|\{channels\}|\{pathId\}/,
  );

  // ----- Anti-regression: no "I'm in test env / DB context not injected" excuses -----
  expect(allText).not.toMatch(
    /数据库上下文还没有完全注入|测试环境中运行|database context not injected|cannot access database|missing dependency/i,
  );

  // ----- No tool errors leaked to console -----
  const toolErrors = consoleErrors.filter((e) =>
    /Tool .* failed|Missing dependency|FK violation|Failed query/i.test(e),
  );
  expect(toolErrors, `console errors: ${toolErrors.join('\n')}`).toHaveLength(0);
});
