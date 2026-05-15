import { test, expect } from "@playwright/test";

/**
 * CF-native Team page smoke tests.
 *
 * These run against the CF/Next.js app (not the Railway backend).
 * They don't seed Postgres or mock SSE — they hit the real auth-gated page.
 *
 * The session-gate test covers the unauthenticated redirect case;
 * these tests cover authenticated page structure (assumes sign-in state
 * is set up by the Playwright project configuration).
 */
test.describe("CF Team page", () => {
  test("team page renders the left-rail team section", async ({ page }) => {
    await page.goto("/team");
    // Should contain "Team" section label from the left rail.
    await expect(page.locator("body")).toContainText(/Team/i, {
      timeout: 10_000,
    });
  });

  test("team page shows employees: CMO, Head of Growth, or Social Media Manager", async ({
    page,
  }) => {
    await page.goto("/team");
    await expect(page.locator("body")).toContainText(
      /CMO|Head of Growth|Social Media Manager/i,
      { timeout: 10_000 },
    );
  });

  test("team page composer textarea is visible", async ({ page }) => {
    await page.goto("/team");
    const composer = page.locator("textarea").first();
    await expect(composer).toBeVisible({ timeout: 10_000 });
  });

  test("team page composer accepts text input", async ({ page }) => {
    await page.goto("/team");
    const composer = page.locator("textarea").first();
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("hello team");
    await expect(composer).toHaveValue("hello team");
  });
});
