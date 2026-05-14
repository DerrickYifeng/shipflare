// Spike #4 — Better Auth + Drizzle + D1.
//
// Validates the auth stack can bootstrap inside a Worker against D1.
//
// IMPORTANT — architectural change from original Phase 0 spec:
// The plan called for Hyperdrive + Neon Postgres. We pivoted to D1 to drop
// the external service dependency. See RESULTS.md "Task 11 spec sweep —
// Hyperdrive → D1" for the docs/spec sweep that still needs to happen.
//
// Subtle adapter quirks to remember (Phase 2 traps):
//  - `provider: "sqlite"` is what @better-auth/drizzle-adapter v1.6.11
//    expects for D1. There is no dedicated `provider: "d1"`.
//  - Better Auth's adapter does NOT transform identifiers — the column
//    names in src/db/schema.ts are exactly what the SQL uses, hence
//    camelCase identifiers in both schema.ts and 001_better_auth.sql.
//  - The auth instance is heavy to construct — keep it singleton per
//    Worker isolate to avoid re-bootstrapping on every request.

import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import type { Env } from "../index";

// Note: `ReturnType<typeof betterAuth>` infers the literal options object,
// which makes the resulting `Auth<...>` invariant in unhelpful ways (each
// caller sees a different Auth<T>). Pin the cache to `Auth<BetterAuthOptions>`
// so the singleton is assignable in both directions.
type BetterAuthInstance = Auth<BetterAuthOptions>;

// Per-isolate singleton. Better Auth's setup walks the schema + plugin tree
// and is non-trivial; we don't want to re-pay that cost on every request.
let _auth: BetterAuthInstance | null = null;

export function getAuth(env: Env): BetterAuthInstance {
  if (_auth) return _auth;
  // `env.DB` binding name must match wrangler.jsonc d1_databases[].binding.
  const db = drizzle(env.DB, { schema });
  // Annotate the options as the base `BetterAuthOptions` so `betterAuth()`'s
  // generic resolves to `Auth<BetterAuthOptions>` instead of the literal
  // option-object shape (which would otherwise propagate everywhere).
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
    baseURL: "http://localhost:8787",
  };
  const instance = betterAuth(options);
  _auth = instance;
  return instance;
}

// /spike/04 + /spike/04/session entrypoint.
export default async function handler(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const auth = getAuth(env);

  if (url.pathname === "/spike/04/session") {
    // No cookie → expect session === null (auto-tested).
    const session = await auth.api.getSession({ headers: req.headers });
    return Response.json({ session });
  }

  if (url.pathname === "/spike/04") {
    return Response.json({
      note: "Better Auth + Drizzle + D1 spike",
      probeEndpoint: "/spike/04/session",
      manualOAuth: {
        signIn: "/api/auth/sign-in/social?provider=github",
        callback: "/api/auth/callback/github (auto)",
      },
    });
  }

  return new Response("not found", { status: 404 });
}

// Re-exported for /api/auth/* in src/index.ts. Better Auth ships a single
// fetch-style handler that owns every /api/auth/* route.
export async function authHandler(req: Request, env: Env): Promise<Response> {
  const auth = getAuth(env);
  return auth.handler(req);
}
