// Module augmentation for OpenNext's global `CloudflareEnv` interface.
//
// `wrangler types` only emits bindings declared in wrangler.jsonc (D1, KV,
// Services, etc.) — it does NOT emit secrets, since secrets are runtime-only
// and don't appear in the static config. We augment here so secret reads via
// `getCloudflareContext().env.<NAME>` are typechecked.
//
// Pair this file with apps/web/.dev.vars.example — any var added there must
// be reflected here, and vice-versa.

declare global {
  interface CloudflareEnv {
    // Bindings from wrangler.jsonc. These are also emitted into
    // `worker-configuration.d.ts` under `Cloudflare.Env`, but OpenNext's
    // `CloudflareEnv` is a separate global interface — we re-declare here
    // so reads via `getCloudflareContext().env.<NAME>` typecheck.
    DB: D1Database;
    CORE: Fetcher;

    // Better Auth secrets. Set via .dev.vars locally, `wrangler secret put`
    // in staging / production.
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;

    // Browser → core JWT signing. Same secret as apps/core's MCP_JWT_SECRET —
    // the web Worker signs short-lived tokens that core verifies on each
    // /agents/<role>/<userId>/mcp call.
    MCP_JWT_SECRET: string;

    // Public URL of the apps/core Worker — used to build the browser-facing
    // MCP endpoint that `/api/mcp-token` returns. The browser connects to
    // `${CORE_PUBLIC_URL}/agents/<role>/<userId>/mcp` directly (per spec D13).
    // Optional: defaults to `http://localhost:3001` in `next dev` (apps/core's
    // default `wrangler dev` port). Set per-environment for staging/prod.
    CORE_PUBLIC_URL?: string;
  }
}

export {};
