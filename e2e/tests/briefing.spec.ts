import { test, expect } from "@playwright/test";

test.describe("Briefing redirect smoke", () => {
  test("/today redirects to /briefing", async ({ page }) => {
    const res = await page.goto("/today");
    expect(res?.url()).toMatch(/\/briefing/);
  });

  test("/calendar redirects to /briefing", async ({ page }) => {
    const res = await page.goto("/calendar");
    expect(res?.url()).toMatch(/\/briefing/);
  });

  test("/chat returns 404", async ({ page }) => {
    const res = await page.goto("/chat");
    expect(res?.status()).toBe(404);
  });
});
