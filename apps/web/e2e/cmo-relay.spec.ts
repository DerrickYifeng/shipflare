import { test, expect } from "@playwright/test";

/**
 * 5.1c.18 — End-to-end smoke for the daily-relay alarm path.
 *
 * Mirrors the existing `cmo-chat.spec.ts` infrastructure (same storageState
 * shape, same dev-server expectations). NOT part of standard CI; requires:
 *
 *   - Real `ANTHROPIC_API_KEY` in `apps/core/.dev.vars` (the relay turn is
 *     an actual LLM call).
 *   - `apps/core` running on port 8787 (`pnpm --filter @shipflare/core dev`).
 *   - `apps/web` running on port 3000 (`pnpm --filter web dev`).
 *   - `ENABLE_ADMIN_TRIGGER_RELAY=1` exported in apps/web's environment
 *     (the `/api/admin/trigger-relay` route is locked behind this flag
 *     + `NODE_ENV !== 'production'`).
 *   - `apps/web/auth-state.json` — Playwright storageState captured from a
 *     prior `pnpm dev` session where the founder signed in. Per memory
 *     `feedback_playwright_real_browser_in_plans`, the developer's
 *     GitHub/X creds are already linked so this only needs to be
 *     regenerated when the session cookie expires.
 *   - The founder's `founder_context.productName` must be set (otherwise
 *     `alarm()` emits `relay-skip-no-product` and never streams a turn —
 *     run the onboarding wizard once to satisfy this).
 *
 * Flow:
 *   1. Visit /chat with the pre-authenticated session (storageState).
 *   2. Wait for the chat input to render (proves WS connect succeeded).
 *   3. POST /api/admin/trigger-relay → forwards to core via Service Binding
 *      → CMO DO's /internal/trigger-alarm → CMO.alarm() → runRelayTurn().
 *   4. Wait up to 90s for the relay's assistant response. The exact wording
 *      is non-deterministic (LLM) but the SYNTHETIC_CRON_PROMPT biases the
 *      response toward "relay", "queued", "drafted", or "today".
 *   5. Sanity assertion: at least one assistant-role MessageBubble exists.
 *
 * The approval-queue UI assertion from the original spec sketch was dropped
 * because: (a) `/api/drafts` doesn't exist yet, and (b) the LLM may handle
 * the synthetic prompt by summarising existing plan items rather than
 * spawning new drafts. Verifying the assistant response is the load-bearing
 * signal — the rest is best left for the manual run to inspect.
 *
 * Run with:
 *   pnpm --filter web exec playwright test e2e/cmo-relay.spec.ts
 */

test.use({ storageState: "auth-state.json" });

test("daily-relay alarm produces an assistant response", async ({
  browser,
  request,
}) => {
  const ctx = await browser.newContext({ storageState: "auth-state.json" });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/chat");

  // Chat input mounts after the WS upgrade completes and the surface
  // hydrates. Re-using the same selector cmo-chat.spec.ts uses.
  await expect(page.getByLabel("message")).toBeVisible({ timeout: 15_000 });

  // Snapshot the count of assistant bubbles BEFORE we trigger the relay,
  // so we can assert a strictly-new one shows up afterward. Without this,
  // a chat history with prior assistant turns would short-circuit the
  // wait and falsely pass.
  const assistantBubbles = page.locator(
    "[data-testid='message-bubble'][data-role='assistant']",
  );
  const beforeCount = await assistantBubbles.count();

  // Fire the relay. `request` reuses the page's storageState (and therefore
  // the session cookie) for the API call.
  const trigger = await request.post(
    "http://localhost:3000/api/admin/trigger-relay",
  );
  expect(
    trigger.ok(),
    `trigger-relay expected 2xx, got ${trigger.status()}: ${await trigger.text().catch(() => "<no body>")}`,
  ).toBeTruthy();

  // Wait for a NEW assistant bubble to land. The relay turn is a fresh LLM
  // call so anything from ~5s (cached prompt, short tool path) to ~60s
  // (rich consult fan-out) is plausible — 90s gives the LLM headroom.
  await expect
    .poll(() => assistantBubbles.count(), {
      timeout: 90_000,
      message:
        "no new assistant bubble appeared within 90s of triggering the relay",
    })
    .toBeGreaterThan(beforeCount);

  // The new bubble's text should mention SOMETHING about the daily relay
  // — the SYNTHETIC_CRON_PROMPT primes the LLM strongly enough that one
  // of these substrings essentially always lands. If this assertion
  // flakes, widen the regex rather than pinning to exact wording.
  await expect(
    page.getByText(/relay|queued|drafted|today|plan/i).first(),
  ).toBeVisible({ timeout: 5_000 });
});
