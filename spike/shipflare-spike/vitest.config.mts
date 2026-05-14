import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Spike #8 — Register the sibling `shipflare-spike-callee` Worker as
      // an auxiliary worker inside the miniflare instance so the `CALLEE`
      // service binding resolves at test time. Without this, miniflare
      // refuses to start: "binding CALLEE refers to a service ..., but no
      // such service is defined".
      //
      // Auxiliary workers do NOT go through Vite, so we can't reference the
      // sibling's `src/index.ts` directly. Inline a JS-equivalent of the
      // callee's handler (same echo contract) so the test path can validate
      // the binding wire-up end-to-end. The canonical implementation in
      // `../shipflare-spike-callee/src/index.ts` is what `wrangler dev`
      // and production deploy run; the inline copy below is a test-only
      // stub kept intentionally trivial.
      miniflare: {
        workers: [
          {
            name: "shipflare-spike-callee",
            modules: true,
            compatibilityDate: "2026-05-01",
            compatibilityFlags: ["nodejs_compat"],
            script: `
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  return Response.json({
                    pathReceived: url.pathname,
                    methodReceived: request.method,
                    headerEcho: Object.fromEntries(request.headers),
                    timestamp: Date.now(),
                    callee: "shipflare-spike-callee",
                  });
                },
              };
            `,
          },
        ],
      },
    }),
  ],
  test: {},
});
