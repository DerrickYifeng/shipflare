import { describe, it, expect } from "vitest";
import { scrapeWebsite } from "../../src/lib/onboarding/scraper";

describe("scrapeWebsite", () => {
  it("rejects single-label hostnames", async () => {
    const result = await scrapeWebsite("http://localhost/");
    expect(result.status).toBe("error");
    expect(result.error).toBe("Invalid URL");
  });

  it("rejects URLs with embedded credentials", async () => {
    const result = await scrapeWebsite("https://user:pass@example.com/");
    expect(result.status).toBe("error");
  });

  it("rejects pathologically long URLs", async () => {
    const result = await scrapeWebsite("https://example.com/" + "a".repeat(3000));
    expect(result.status).toBe("error");
  });
});
