import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal OpenNext config — no incremental cache, no tag cache, no R2/KV
// overrides yet. Phase 1 only ships the auth + sign-in flow + healthz; any
// page-level caching layers (D1-backed tag cache, R2 static assets) come in
// S7 / S8 alongside the actual founder UI surfaces.
export default defineCloudflareConfig({});
