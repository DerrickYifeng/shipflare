import { test, expect } from "@playwright/test";

test.describe("Session-gated routes", () => {
  test("/team without session redirects to /", async ({ page }) => {
    await page.goto("/team");
    // After the (app) layout's server-side redirect, we land on /.
    await expect(page).toHaveURL(/\/$/);
    // And the landing page content should be visible.
    await expect(page.locator("h1")).toContainText("ShipFlare");
  });

  test("/briefing without session redirects to /", async ({ page }) => {
    await page.goto("/briefing");
    await expect(page).toHaveURL(/\/$/);
  });
});
