import { test, expect } from "@playwright/test";

test.describe("Health checks", () => {
  test("web /api/healthz returns ok=true", async ({ request }) => {
    const res = await request.get("/api/healthz");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.app).toBe("web");
    expect(typeof body.ts).toBe("number");
  });
});
