import { test, expect } from "@playwright/test";

test.describe("Session-gated routes", () => {
  test("/chat without session redirects to /", async ({ page }) => {
    await page.goto("/chat");
    // After the (app) layout's server-side redirect, we land on /.
    await expect(page).toHaveURL(/\/$/);
    // And the landing page content should be visible.
    await expect(page.locator("h1")).toContainText("ShipFlare");
  });

  test("/team without session redirects to /", async ({ page }) => {
    await page.goto("/team");
    await expect(page).toHaveURL(/\/$/);
  });

  test("/drafts without session redirects to /", async ({ page }) => {
    await page.goto("/drafts");
    await expect(page).toHaveURL(/\/$/);
  });
});
