import { test, expect } from "@playwright/test";

test.describe("Landing page", () => {
  test("renders 'ShipFlare' headline", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("ShipFlare");
  });

  test("shows 'Sign in with GitHub' link", async ({ page }) => {
    await page.goto("/");
    const link = page.locator("a", { hasText: /sign in with github/i });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain("/api/auth/sign-in/social");
    expect(href).toContain("provider=github");
  });
});
