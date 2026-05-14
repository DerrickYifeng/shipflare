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

    // Phase 2 external MCP token signing. Same secret as apps/core's
    // EXTERNAL_MCP_SECRET — /api/external-mcp/issue mints long-lived (30d)
    // tokens for 3rd-party MCP clients (Claude Desktop, Cursor). Distinct
    // from MCP_JWT_SECRET so a leaked browser-session token can't be used
    // to impersonate a 3rd-party client.
    EXTERNAL_MCP_SECRET: string;

    // Public URL of the apps/core Worker — used to build the browser-facing
    // MCP endpoint that `/api/mcp-token` returns. The browser connects to
    // `${CORE_PUBLIC_URL}/agents/<role>/<userId>/mcp` directly (per spec D13).
    // Optional: defaults to `http://localhost:3001` in `next dev` (apps/core's
    // default `wrangler dev` port). Set per-environment for staging/prod.
    CORE_PUBLIC_URL?: string;

    // Per-platform OAuth client credentials. Registered at:
    //   X (Twitter) — developer.twitter.com → App → Keys and tokens →
    //     OAuth 2.0 Client ID and Secret. Callback URL must equal
    //     `${BETTER_AUTH_URL}/api/channels/x/callback`.
    //   Reddit — reddit.com/prefs/apps → web app. Redirect URI must equal
    //     `${BETTER_AUTH_URL}/api/channels/reddit/callback`.
    X_CLIENT_ID: string;
    X_CLIENT_SECRET: string;
    REDDIT_CLIENT_ID: string;
    REDDIT_CLIENT_SECRET: string;
    // P2-E. LinkedIn OAuth 2.0 app — linkedin.com/developers → Apps →
    //   Create app → Auth tab → "OAuth 2.0 settings" → Authorized
    //   redirect URLs. Must equal `${BETTER_AUTH_URL}/api/channels/linkedin/callback`.
    //   Scopes: r_liteprofile, w_member_social (request via the
    //   "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn"
    //   products on the app's Products tab).
    LINKEDIN_CLIENT_ID: string;
    LINKEDIN_CLIENT_SECRET: string;

    // AES-GCM key (base64, 32 bytes) used by @shipflare/crypto to envelope-
    // encrypt channel OAuth tokens before they hit D1. Rotating this
    // invalidates every connected channel — they'll need to re-auth.
    //   openssl rand -base64 32
    CHANNEL_ENC_KEY: string;
  }
}

// P2-F — VAPID public key inlined into the browser bundle at build time
// (Next.js bundles `process.env.NEXT_PUBLIC_*` literally into client code).
// Declared on `ProcessEnv` so the `/notifications` client typechecks against
// the bundled value. The matching SERVER-SIDE secret lives on apps/core
// (`Env.VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT`) — apps/web does
// NOT need the private key.
declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_VAPID_PUBLIC?: string;
  }
}

export {};
