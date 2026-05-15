# Cloudflare Deploy Checklist — ShipFlare

One-time setup before the first production deploy. Subsequent deploys just
run `./scripts/deploy-cf.sh`.

## Prerequisites

- Cloudflare account on the **Workers Paid plan** ($5/mo) — required for:
  - Durable Objects (CMO / HoG / SMM / X_MCP / REDDIT_MCP)
  - D1 database with > 100k writes/day
  - Workflows binding
- Wrangler v4+ installed: `npm i -g wrangler@latest`
- `wrangler login` completed (browser auth)

## Step 1 — Provision D1

```bash
cd apps/core
pnpm exec wrangler d1 create shipflare-prod
```

Copy the printed `database_id` into `apps/core/wrangler.jsonc` (replace the
placeholder UUID `00000000-0000-0000-0000-000000000000`).

Mirror the same `database_id` into `apps/web/wrangler.jsonc` (both Workers
share the D1 DB).

Apply schema:

```bash
pnpm exec wrangler d1 migrations apply shipflare-prod --remote
```

## Step 2 — Register OAuth apps

**GitHub** (for Better Auth login):
- https://github.com/settings/developers → New OAuth App
- Homepage URL: `https://shipflare.com`
- Callback URL: `https://shipflare.com/api/auth/callback/github`

**X** (for channel connection):
- https://developer.twitter.com/en/portal → Create app
- Callback URL: `https://shipflare.com/api/channels/x/callback`
- Scopes: tweet.read, tweet.write, users.read, offline.access
- App type: OAuth 2.0 (with PKCE)

**Reddit** (for channel connection):
- https://www.reddit.com/prefs/apps → Create app (web app type)
- Redirect URI: `https://shipflare.com/api/channels/reddit/callback`

## Step 3 — Generate cryptographic secrets

```bash
# 32-byte AES key (base64) — for channel oauth token encryption
openssl rand -base64 32

# Better Auth secret — for session signing
openssl rand -base64 32

# MCP JWT secret — for browser → core auth
openssl rand -base64 32
```

Save these to a password manager. They MUST be identical between apps/core
and apps/web for shared secrets (CHANNEL_ENC_KEY, MCP_JWT_SECRET).

## Step 4 — Set secrets

For **apps/core**:

```bash
cd apps/core
pnpm exec wrangler secret put ANTHROPIC_API_KEY        # from console.anthropic.com
pnpm exec wrangler secret put XAI_API_KEY              # from console.x.ai
pnpm exec wrangler secret put MCP_JWT_SECRET           # 32-byte random
pnpm exec wrangler secret put CHANNEL_ENC_KEY          # 32-byte random (same as web)
```

For **apps/web**:

```bash
cd ../web
pnpm exec wrangler secret put BETTER_AUTH_SECRET       # 32-byte random
pnpm exec wrangler secret put BETTER_AUTH_URL          # https://shipflare.com
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put X_CLIENT_ID
pnpm exec wrangler secret put X_CLIENT_SECRET
pnpm exec wrangler secret put REDDIT_CLIENT_ID
pnpm exec wrangler secret put REDDIT_CLIENT_SECRET
pnpm exec wrangler secret put MCP_JWT_SECRET           # SAME value as apps/core
pnpm exec wrangler secret put CHANNEL_ENC_KEY          # SAME value as apps/core
pnpm exec wrangler secret put CORE_PUBLIC_URL          # https://shipflare-core.<account>.workers.dev
pnpm exec wrangler secret put ANTHROPIC_API_KEY        # required for /api/onboarding/{extract,extract-repo,plan} — distinct from apps/core key
```

> The onboarding routes return 503 `anthropic_not_configured` when this secret is unset. The key can be the same as apps/core's or a separate budget-scoped key.

## Step 5 — Deploy

```bash
cd ../..
./scripts/deploy-cf.sh
```

## Step 6 — Smoke test

```bash
# Core healthz
curl https://shipflare-core.<account>.workers.dev/healthz

# Web landing page
curl https://shipflare.com/

# Sign in flow
open https://shipflare.com  # complete GitHub OAuth in browser
```

After signing in, the Better Auth `databaseHooks.user.create.after` hook fires
`POST /agents/cmo/<userId>/internal/init` against the core worker — verify by
checking the CMO DO's `founder_context` table has rows.

## Step 7 — Configure custom domains (optional)

In the Cloudflare dashboard:
- Add `shipflare.com` to apps/web (Workers → shipflare-web → Custom Domains)
- Add `core.shipflare.com` to apps/core
- Update `BETTER_AUTH_URL` and `CORE_PUBLIC_URL` secrets to match

## Rollback

`wrangler rollback <VERSION_ID>` per worker. List available versions:

```bash
pnpm exec wrangler versions list
```

D1 schema changes are forward-only — no automatic rollback for migrations.
If a migration breaks prod, roll back the worker version and revert the
migrations directory in source control. (Phase 1 has no schema downgrades —
all migrations are additive.)
