import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Phase 0 spike pattern. `@cloudflare/vitest-pool-workers@0.16.4` exports the
 * `cloudflareTest` Vite plugin — NOT the legacy `defineWorkersConfig` helper.
 *
 * `wrangler.configPath` points at this app's wrangler.jsonc so miniflare
 * mounts the same DO / D1 / cron / Workflow bindings the deployed Worker
 * sees. As DO classes come online in S2-S5, no test-config change is needed
 * — they ride along automatically via wrangler.jsonc.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
