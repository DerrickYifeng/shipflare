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
      // Test-only bindings layered over wrangler.jsonc. `STRATEGIC_PATH_FIXTURE`
      // is the env-flag that gates fixture mode in `onboarding-routes.ts` —
      // we set it here so `strategic-path-activity.test.ts` doesn't have to
      // pass `_test_fixture` through the request body (which was the
      // trust-boundary leak the body-flag opened: any authenticated browser
      // could spread the same flag through the web proxy and force core to
      // skip the LLM call + schema validation). Production never sets this
      // binding.
      miniflare: {
        bindings: {
          STRATEGIC_PATH_FIXTURE: "1",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
