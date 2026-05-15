import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E smoke for ShipFlare (Cloudflare Phase 1).
 *
 * Phase 1 scope: minimal regression guard. Real flows (OAuth dance, chat,
 * approve→post) come once staging has seeded test users.
 *
 * Target the deployed worker via SHIPFLARE_URL. Defaults to a locally-running
 * `pnpm --filter @shipflare/web dev` on :3000.
 *
 * `testMatch` is scoped to the three Phase 1 smoke specs so this config does
 * NOT accidentally pick up the legacy v1/v2 specs that also live under
 * `e2e/tests/` (those are driven by the root `playwright.config.ts`). When
 * legacy is removed in a later phase, we can drop the explicit match list
 * and revert to Playwright's default spec-file glob.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "landing.spec.ts",
    "healthz.spec.ts",
    "session-gate.spec.ts",
  ],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["list"],
  ],
  timeout: 30_000,
  use: {
    baseURL: process.env.SHIPFLARE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Don't auto-start the dev server — tests assume the caller already has
  // `pnpm --filter @shipflare/web dev` running on :3000. CI uses a
  // separately-started staging URL via SHIPFLARE_URL.
});
