import { test, expect } from "@playwright/test";

/**
 * Playwright smoke for the founder-facing CMO chat surface.
 *
 * This spec is **not** intended to run in standard CI; it requires:
 *   - a running dev server (`pnpm dev`) on http://localhost:3000
 *   - a real Anthropic API key (the chat actually streams)
 *   - an authenticated browser context (storage state captured from a
 *     prior manual session — saved to `auth-state.json`)
 *
 * Phase 11 of the CF-native chat migration owns running this against
 * the dev deploy. Per the project memory
 * `feedback_playwright_real_browser_in_plans`, this test reuses the
 * developer's pre-authenticated browser context (GitHub + X already
 * signed in for the founder).
 *
 * Phase 11 prerequisite: Playwright must be set up for apps/web.
 * A `playwright.config.ts` at apps/web/ is needed before this spec
 * can run. Suggested testDir: "./e2e", baseURL: "http://localhost:3000".
 */
test("founder sees reasoning + nested agent run + resumable stream", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ storageState: "auth-state.json" });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/chat");

  await page
    .getByLabel("message")
    .fill(
      "Plan a small launch campaign and ask Head of Growth what to measure.",
    );
  await page.getByRole("button", { name: /send/i }).click();

  // Reasoning part should appear within 15s of dispatch (Claude
  // thinking is the first streaming event the chat surface emits).
  await expect(page.getByTestId("reasoning-part").first()).toBeVisible({
    timeout: 15_000,
  });

  // The LLM's consult tool call should surface as a NestedAgentRun
  // card labeled "Head of Growth" within 45s.
  await expect(
    page.getByTestId("nested-agent-run").filter({ hasText: "Head of Growth" }),
  ).toBeVisible({ timeout: 45_000 });

  // Reload mid-stream → resumable. The user's first message must
  // persist and the in-flight nested-agent-run must reappear.
  await page.reload();
  await expect(
    page.getByText(/Plan a small launch campaign/),
  ).toBeVisible();
  await expect(page.getByTestId("nested-agent-run")).toBeVisible();

  // Assistant's final text response should land within 90s.
  await expect(page.getByTestId("text-part").last()).toBeVisible({
    timeout: 90_000,
  });
});
