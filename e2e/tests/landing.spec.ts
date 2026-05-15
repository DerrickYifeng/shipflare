import { test, expect } from "@playwright/test";

test.describe("Landing page", () => {
  test("renders hero heading", async ({ page }) => {
    await page.goto("/");
    // HeroDemo renders <h1 id="hero-heading"> with the marketing headline
    await expect(page.locator("h1").first()).toBeVisible();
  });

  test("shows sign-up CTA for unauthenticated visitors", async ({ page }) => {
    await page.goto("/");
    // GlassNav renders a "Sign up" button for unauthenticated users
    const signUpButton = page.getByRole("button", { name: /sign up/i });
    await expect(signUpButton).toBeVisible();
  });

  test("nav contains marketing section anchors", async ({ page }) => {
    await page.goto("/");
    // GlassNav renders anchor links to sections
    await expect(page.locator('a[href="#how"]')).toBeVisible();
  });
});
