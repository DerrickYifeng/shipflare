import {
  betterAuth,
  type Auth,
  type BetterAuthOptions,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "@shipflare/db";
import { getDb } from "./db";

// Per-isolate Better Auth singleton. Better Auth's setup walks the schema +
// plugin tree and is non-trivial; we don't want to re-pay that cost on every
// request. Phase 0 spike #4 validated this pattern.
//
// Pin the cache to `Auth<BetterAuthOptions>` (the base option type) instead
// of inferring `ReturnType<typeof betterAuth>` — the literal-options inference
// makes `Auth<T>` invariant in unhelpful ways. See spike/04-better-auth.ts.
type BetterAuthInstance = Auth<BetterAuthOptions>;
let _auth: BetterAuthInstance | null = null;

/**
 * Build (or return the cached) Better Auth instance.
 *
 * Reads env via `getCloudflareContext()` from OpenNext — this works in both
 * Worker runtime AND `next dev` (via `initOpenNextCloudflareForDev()` in
 * next.config.ts which wires a wrangler proxy for local bindings).
 *
 * Phase 0 findings applied:
 *   - `provider: "sqlite"` for D1 (NOT "d1"; there is no dedicated d1 provider).
 *   - `baseURL` is env-driven via `BETTER_AUTH_URL` — a hardcoded localhost URL
 *     silently breaks OAuth callbacks in staging/production.
 *   - `databaseHooks.user.create.after` fires the CMO `internal/init` request
 *     fire-and-forget on first sign-up (idempotent core-side).
 */
export function getAuth(): BetterAuthInstance {
  if (_auth) return _auth;

  const { env } = getCloudflareContext();
  const db = getDb(env);

  // Annotate as the base options type so `betterAuth()`'s generic resolves
  // to `Auth<BetterAuthOptions>` rather than the literal option-object shape
  // (which otherwise propagates through every caller and breaks the cache).
  const options: BetterAuthOptions = {
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    // Env-driven base URL. Set per-environment:
    //   .dev.vars                       BETTER_AUTH_URL=http://localhost:3000
    //   wrangler secret put             BETTER_AUTH_URL  (preview / production)
    // The fallback is dev-only and exists only so the singleton can boot
    // before secrets are wired; OAuth callbacks will not function until a
    // real URL is configured.
    baseURL: env.BETTER_AUTH_URL ?? "http://localhost:3000",
    databaseHooks: {
      user: {
        create: {
          // First-login CMO init hook. Fire-and-forget — a failure here MUST
          // NOT block sign-in. The CMO's /internal/init endpoint is idempotent
          // (returns "already_initialized" on subsequent calls) so a retry
          // on the user's next session is safe.
          //
          // Service Binding semantics (Phase 0 spike #8): host header and
          // cf-connecting-ip are stripped across the binding. We pass a
          // synthetic "https://internal/..." origin and signal sibling-Worker
          // intent via `x-shipflare-internal: 1`, which core verifies on the
          // /internal/* routes (S2.6).
          after: async (user) => {
            try {
              await env.CORE.fetch(
                new Request(
                  `https://internal/agents/cmo/${user.id}/internal/init`,
                  {
                    method: "POST",
                    headers: {
                      "x-shipflare-internal": "1",
                      "content-type": "application/json",
                    },
                    body: JSON.stringify({
                      email: user.email,
                      githubLogin: user.name ?? null,
                    }),
                  },
                ),
              );
            } catch (err) {
              // Best-effort: log and continue. Sign-in completes regardless.
              // The CMO init will be retried on next request to its DO since
              // initialization is gated on a flag the DO checks on each tick.
              console.warn(
                "CMO init failed (will retry on next session):",
                err,
              );
            }
          },
        },
      },
    },
  };

  _auth = betterAuth(options);
  return _auth;
}
