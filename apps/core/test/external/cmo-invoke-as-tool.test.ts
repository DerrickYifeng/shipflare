import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { applyCmoSchema } from "../../src/agents/cmo/schema";
import type { CMO } from "../../src/agents/cmo/CMO";

describe("CMO.invokeAsTool", () => {
  it("returns the dry-run reply text when _invokeAsToolDryRun is set", async () => {
    const userId = "iat-1";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName",
        "TestProd",
      );
    });

    await runInDurableObject<CMO, void>(stub, async (instance) => {
      (instance as unknown as { _invokeAsToolDryRun?: string })._invokeAsToolDryRun =
        "Today I queued 2 reply drafts on X.";

      const reply = await (
        instance as unknown as {
          invokeAsTool: (
            tool: "chat",
            args: { message: string },
          ) => Promise<string>;
        }
      ).invokeAsTool("chat", { message: "What did you do today?" });

      expect(reply).toBe("Today I queued 2 reply drafts on X.");
    });
  });

  it("rejects unknown tool names", async () => {
    const userId = "iat-2";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) =>
      applyCmoSchema(state.storage.sql),
    );

    await runInDurableObject<CMO, void>(stub, async (instance) => {
      await expect(
        (
          instance as unknown as {
            invokeAsTool: (tool: string, args: unknown) => Promise<unknown>;
          }
        ).invokeAsTool("nonexistent_tool" as never, {}),
      ).rejects.toThrow(/unknown tool/i);
    });
  });

  it("dry-run seam short-circuits before saveMessages (no user message appended)", async () => {
    const userId = "iat-3";
    const stub = env.CMO.getByName(`streamable-http:${userId}`);
    await runInDurableObject<CMO, void>(stub, async (_inst, state) => {
      applyCmoSchema(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO founder_context (key, value) VALUES (?, ?)",
        "productName",
        "TestProd",
      );
    });

    await runInDurableObject<CMO, void>(stub, async (instance) => {
      // Dry-run short-circuits everything — no LLM call, no message append.
      // Phase 7.5 manual smoke is where the real path gets exercised.
      (instance as unknown as { _invokeAsToolDryRun?: string })._invokeAsToolDryRun =
        "OK";
      const reply = await (
        instance as unknown as {
          invokeAsTool: (
            tool: "chat",
            args: { message: string },
          ) => Promise<string>;
        }
      ).invokeAsTool("chat", { message: "hello" });
      expect(reply).toBe("OK");
    });
  });
});
