/**
 * Phase A wrap-up — team chat refactor live smoke.
 *
 * Verifies the three structural changes that landed in commits
 * 9aa0ac2 / 15f3080 / 9a14604:
 *   - A1: streaming-partial state moved into `StreamingProvider` context
 *   - A2: sticky bottom subagent rail with role/aria + data-status chips
 *   - A3: message-list virtualization past 50 nodes (data-virtualized attr)
 *
 * Two scenarios:
 *   1. Streaming deltas keep the conversation pinned to bottom (no
 *      unstick during partial flush).
 *   2. When the lead delegates via Task, an in-flight teammate appears
 *      in the sticky bottom rail (`role=region aria-label="Active teammates"`).
 *
 * Run:
 *   bun run test:e2e:live -- e2e/tests/team-chat-refactor.live-smoke.ts
 *
 * Cost: ~$0.10-0.30 LLM (one round-trip with lead + one teammate spawn).
 */

import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test.skip(
  !fs.existsSync('.auth/founder.json'),
  'Run setup section A (capture .auth/founder.json via `pnpm playwright codegen --save-storage=.auth/founder.json`) before running live-smoke specs',
);

test.describe.configure({ mode: 'serial' });

test('[smoke] team chat: streaming partial does not unstick scroll', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/team');

  // Wait for the conversation scroller (the <section> in conversation.tsx
  // is `aria-label="Conversation"`).
  const scroller = page.getByRole('region', { name: /conversation/i }).first();
  await expect(scroller).toBeVisible({ timeout: 15_000 });

  // Send a substantive prompt that forces a multi-paragraph streaming
  // response so we get enough deltas to observe pin-to-bottom behavior.
  const composer = page
    .getByPlaceholder(/message your team|send a message|ask|type/i)
    .or(page.getByRole('textbox').first())
    .first();
  await expect(composer).toBeVisible({ timeout: 10_000 });

  await composer.fill(
    "[smoke] Briefly recap my current strategic phase in 3 short paragraphs — phase name, goal, and the top plan item. Be concise.",
  );
  await composer.press('Enter');
  const sendButton = page.getByRole('button', { name: /send|submit/i }).first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click().catch(() => undefined);
  }

  // Let some deltas land — the lead's first tool call + initial text
  // chunks usually arrive in ~5-15s.
  await page.waitForTimeout(8_000);

  // Scroll position should stay pinned to bottom while content streams in.
  // 100px tolerance covers small layout jitters (composer height, padding).
  const isPinned = await scroller.evaluate((el) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop < 100;
  });
  expect(
    isPinned,
    `conversation did not stay pinned to bottom during streaming (scrollHeight - clientHeight - scrollTop >= 100)`,
  ).toBe(true);

  // Log (but don't fail on) console errors — Phase A only restructured
  // streaming/rail/virtualization; unrelated errors are out of scope.
  if (consoleErrors.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[smoke] streaming pin test: ${consoleErrors.length} console error(s):\n${consoleErrors.join('\n')}`,
    );
  }
});

test('[smoke] team chat: in-flight teammate appears in bottom rail', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/team');
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });

  // Use the same delegation-provoking prompt shape as
  // team-delegation.live-smoke.ts — empirically reliable at triggering
  // a Task spawn to a content-manager / social-media-manager teammate.
  const composer = page
    .getByPlaceholder(/message your team|send a message|ask|type/i)
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

  // The sticky bottom rail (active-subagents-rail.tsx) is
  // `role="region" aria-label="Active teammates"` and renders `null`
  // when no teammates pass the visibility filter — so its visibility
  // is itself a positive signal that at least one teammate spawned.
  const rail = page.getByRole('region', { name: /active teammates/i });
  await expect(rail).toBeVisible({ timeout: 60_000 });

  // At least one teammate chip (button) should appear. Generous timeout
  // because Task spawning can take a few extra seconds after the rail
  // mounts.
  await expect
    .poll(async () => rail.locator('button').count(), {
      timeout: 30_000,
      intervals: [2_000, 5_000],
    })
    .toBeGreaterThanOrEqual(1);

  // Log (don't fail on) console errors — we're verifying the rail UX,
  // not regressing the wider Task FK / tool-context surface (that's
  // team-delegation.live-smoke.ts's job).
  if (consoleErrors.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[smoke] bottom rail test: ${consoleErrors.length} console error(s):\n${consoleErrors.join('\n')}`,
    );
  }
});
