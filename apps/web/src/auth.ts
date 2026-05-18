import {
  betterAuth,
  type Auth,
  type BetterAuthOptions,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "@shipflare/db";
import { allowedEmails, and, eq, isNull } from "@shipflare/db";
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
 * Decide whether to widen the session cookie scope to a parent domain so
 * `apps/core` on a sibling subdomain (e.g. `mcp-staging.shipflare.ai`)
 * can read it during the Phase 7 external MCP `/authorize` handshake.
 *
 * Returns `{ domain }` only when `baseURL` is a real zone we own
 * (`*.shipflare.ai` or `*.shipflare.com`). Skips:
 *   - localhost (no parent domain to widen to)
 *   - `*.workers.dev` (Public Suffix List — browsers refuse `domain=workers.dev`)
 *   - anything else unrecognized (fail closed — don't accidentally widen)
 */
function cookieDomainAttribute(baseUrl: string | undefined): { domain?: string } {
  if (!baseUrl) return {};
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return {};
  }
  for (const zone of ["shipflare.ai", "shipflare.com"] as const) {
    if (host === zone || host.endsWith(`.${zone}`)) {
      return { domain: `.${zone}` };
    }
  }
  return {};
}

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
        // `public_repo` is required by the onboarding flow's GitHub repo
        // picker (`/api/onboarding/github-repos`) — Better Auth stores the
        // resulting access token in the `account` table; the route uses it
        // to call api.github.com/user/repos and api.github.com/repos/.../readme.
        // Existing GitHub-linked users must sign in once after this change
        // to upgrade their stored token's scope. Better Auth does not
        // auto-refresh scopes.
        scope: ["read:user", "user:email", "public_repo"],
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
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
    // Cloudflare strips the original client IP from `request.headers.get('x-forwarded-for')`
    // but injects the real one as `cf-connecting-ip`. Without this Better Auth's
    // rate limiter falls back to "unknown" and warns on every request.
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      // Force non-Secure cookies whenever the baseURL is http:// (local dev).
      // Better Auth's default heuristic doesn't always catch this in Workers
      // + OpenNext for Dev, and a Secure-flagged cookie is silently dropped
      // by browsers on http:// origins — manifesting as
      //   "State mismatch: State not persisted correctly"
      // because the OAuth state cookie set on POST /api/auth/sign-in/social
      // never makes it back on the /api/auth/callback/<provider> hop.
      useSecureCookies: (env.BETTER_AUTH_URL ?? "").startsWith("https://"),
      defaultCookieAttributes: {
        sameSite: "lax",
        path: "/",
        httpOnly: true,
        // Cross-subdomain cookie sharing for the Phase 7 external MCP
        // `/authorize` handshake. apps/core lives on a sibling subdomain
        // (`mcp-staging.shipflare.ai` / `mcp.shipflare.com`) and reads
        // this session cookie via service binding when an MCP client
        // opens `/authorize` in the browser. Cookies set host-only on
        // apps/web would never reach apps/core.
        //
        // Only set the `domain` attribute when BETTER_AUTH_URL points at
        // a real zone we control — otherwise we'd silently widen scope
        // on `*.workers.dev` (which is in the Public Suffix List and
        // wouldn't honor it anyway) or break local dev on localhost.
        ...cookieDomainAttribute(env.BETTER_AUTH_URL),
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Allowlist gate — runs BEFORE the user row is created so the
          // sign-up is blocked outright. Throws redirect-style errors that
          // Better Auth surfaces to the OAuth callback handler; the
          // /api/auth/[...all] adapter then forwards to /waitlist with the
          // denied email pre-filled.
          //
          // Source of truth (in priority order):
          //   1. SUPER_ADMIN_EMAIL env (always allowed — safety net).
          //   2. The `allowed_emails` D1 table (admin-managed via
          //      /admin/invites). A row with revokedAt IS NULL = allowed.
          //   3. ALLOWED_EMAILS env var (comma-sep, case-insensitive) —
          //      bootstrap fallback used ONLY when the D1 table is empty.
          //      The intended migration path is: set the env var once to
          //      seed the founder, add invites through /admin/invites,
          //      then clear the env var.
          //
          // If neither source has any entries the gate stays open so the
          // very first sign-up isn't a chicken-and-egg problem.
          before: async (user) => {
            const rawEmail = user.email;
            if (!rawEmail || typeof rawEmail !== "string") {
              throw new Error(
                "BETTER_AUTH_REDIRECT:/waitlist?from=denied&reason=no-email",
              );
            }
            const email = rawEmail.trim().toLowerCase();
            const superAdmin = env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
            if (superAdmin && email === superAdmin) {
              return { data: user };
            }

            // 2. DB lookup — primary source of truth.
            const dbRow = await db
              .select({ email: allowedEmails.email })
              .from(allowedEmails)
              .where(
                and(
                  eq(allowedEmails.email, email),
                  isNull(allowedEmails.revokedAt),
                ),
              )
              .get();
            if (dbRow) {
              return { data: user };
            }

            // 3. Env-var fallback (bootstrap).
            const raw = env.ALLOWED_EMAILS;
            if (raw && raw.trim() !== "") {
              const allowed = raw
                .split(",")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);
              if (allowed.includes(email)) {
                return { data: user };
              }
            }

            // If both DB and env are empty, leave the gate open. Otherwise
            // bounce to the waitlist with the denied email pre-filled.
            const dbHasAny = await db
              .select({ email: allowedEmails.email })
              .from(allowedEmails)
              .where(isNull(allowedEmails.revokedAt))
              .limit(1)
              .get();
            const envHasAny = !!(raw && raw.trim() !== "");
            if (!dbHasAny && !envHasAny) {
              return { data: user };
            }
            throw new Error(
              `BETTER_AUTH_REDIRECT:/waitlist?from=denied&email=${encodeURIComponent(email)}`,
            );
          },
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
