import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

describe("CMO fetch hook calls bootstrapTzIfMissing on x-inferred-tz header", () => {
  it("populates founder_context.tz on first request with the header", async () => {
    const userId = "tzboot-fetch-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => applyCmoSchema(state.storage.sql));

    // Hit a public-facing route (super.fetch handles non-/internal/ paths).
    // The bootstrap should run via the fetch() interceptor regardless of which
    // route the request goes to.
    await stub.fetch(
      new Request("https://internal/health", {
        method: "GET",
        headers: { "x-inferred-tz": "Asia/Hong_Kong" },
      }),
    );

    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      const rows = state.storage.sql
        .exec("SELECT value FROM founder_context WHERE key = 'tz'")
        .toArray() as Array<{ value: string }>;
      expect(rows[0]?.value).toBe("Asia/Hong_Kong");
    });
  });
});
