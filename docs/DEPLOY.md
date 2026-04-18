# DEPLOY.md — Railway Deployment Guide for ShipFlare MVP

This document walks you through a first-time production deploy of ShipFlare on Railway. Follow the steps in order. Everything below assumes the MVP branch (`feat/mvp-launch-ready`) has been merged to `main`.

**Estimated time:** 45–90 minutes for first deploy, <10 minutes for subsequent deploys.

---

## Pre-Flight Checklist

Before touching Railway:

- [ ] `main` branch is green on CI (lint + typecheck + tests + build).
- [ ] You have a Railway account (https://railway.app) and billing set up.
- [ ] You have admin access to the GitHub repo.
- [ ] You have a GitHub OAuth App registered with homepage URL and callback URL ready to switch from localhost to prod.
- [ ] You have an `XAI_API_KEY` from https://console.x.ai (required — without it, `isPlatformAvailable('x')` returns false and the MVP ships dead).
- [ ] You have an `ANTHROPIC_API_KEY` from https://console.anthropic.com.
- [ ] You know the custom domain you want (optional; can start on `*.up.railway.app`).

---

## Step 1 — Create the Railway Project

1. Sign in to Railway → **New Project** → **Deploy from GitHub repo** → select the ShipFlare repo.
2. On the first prompt, Railway will auto-detect Next.js. Let it create the first service (name it `web`).
3. In **Project Settings → Environments**, confirm the default env is named `production` and is tied to the `main` branch.

---

## Step 2 — Add the Worker Service

The worker MUST be a separate Railway service from the web — they have different start commands and different failure modes.

1. Inside the same project, click **+ New** → **GitHub Repo** → select the same ShipFlare repo.
2. Name this service `worker`.
3. In **Settings → Deploy**:
   - **Start Command:** `bun run src/workers/index.ts`
   - **Build Command:** `bun install --frozen-lockfile` (Railway's Nixpacks default should work; override only if it mis-detects).
4. Disable the auto-generated domain on the worker service — it doesn't serve HTTP traffic.

You now have two services: `web` (Next.js, serves traffic) and `worker` (BullMQ runtime, no public port).

---

## Step 3 — Provision Addons

In the project dashboard:

1. Click **+ New** → **Database** → **PostgreSQL**. Railway creates a managed Postgres and injects `DATABASE_URL` into the project's shared variables.
2. Click **+ New** → **Database** → **Redis**. Railway creates a managed Redis and injects `REDIS_URL`.
3. Link both addons to BOTH services (web + worker) via **Variables → Shared**.

**Verify:** Under each service's Variables tab, `DATABASE_URL` and `REDIS_URL` should appear automatically.

---

## Step 4 — Environment Variable Matrix

Set these on BOTH `web` and `worker` unless noted. Use Railway's **Shared Variables** at the project level so you set each only once.

| Variable | Required? | Where to get it | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ Yes | Auto-injected by Postgres addon | Shared |
| `REDIS_URL` | ✅ Yes | Auto-injected by Redis addon | Shared |
| `AUTH_SECRET` | ✅ Yes | `openssl rand -base64 32` | Shared. Losing this invalidates all sessions. |
| `NEXTAUTH_URL` | ✅ Yes | Your public URL, e.g. `https://shipflare.up.railway.app` | Web only. Must be HTTPS in prod. |
| `NEXT_PUBLIC_APP_URL` | ✅ Yes | Same as `NEXTAUTH_URL` | Shared |
| `GITHUB_ID` | ✅ Yes | GitHub OAuth App → Client ID | Shared |
| `GITHUB_SECRET` | ✅ Yes | GitHub OAuth App → generate new secret | Shared |
| `X_CLIENT_ID` | ✅ Yes | https://developer.x.com → your app | Shared |
| `X_CLIENT_SECRET` | ✅ Yes | Same | Shared |
| `X_REDIRECT_URI` | ✅ Yes | `https://<your-domain>/api/x/callback` | Shared. Must match X app config. |
| `XAI_API_KEY` | ✅ Yes | https://console.x.ai | Shared. **Without this, MVP X features silently disable.** |
| `ANTHROPIC_API_KEY` | ✅ Yes | https://console.anthropic.com | Shared |
| `ENCRYPTION_KEY` | ✅ Yes | `openssl rand -hex 32` (exactly 64 hex chars) | Shared. **Losing this = all stored OAuth tokens are unrecoverable. Back it up offline.** |
| `NODE_ENV` | ✅ Yes | `production` | Shared |
| `REDDIT_CLIENT_ID` | ⛔ Optional | Reddit dev portal | Reddit is gated off for MVP. Leave unset; `/api/reddit/callback` will short-circuit to a coming-soon redirect. |
| `REDDIT_CLIENT_SECRET` | ⛔ Optional | Same | Same. |
| `REDDIT_REDIRECT_URI` | ⛔ Optional | Same | Same. |
| `SERPER_API_KEY` | ⛔ Optional | https://serper.dev | Optional search enrichment. |
| `LOG_LEVEL` | ⛔ Optional | `info` recommended for prod | Shared. Defaults to `info`. |
| `LOG_FORMAT` | ⛔ Optional | `json` recommended for prod | Shared. Defaults to pretty. |

**⚠️ Critical backup step:** After generating `ENCRYPTION_KEY` and `AUTH_SECRET`, save copies in your password manager. If you lose them, users must re-connect every channel and re-login.

### GitHub OAuth App configuration

Update your existing OAuth app (or create a new one):
- **Homepage URL:** `https://<your-domain>`
- **Authorization callback URL:** `https://<your-domain>/api/auth/callback/github`

### X (Twitter) OAuth App configuration

Update the callback URL to match `X_REDIRECT_URI`:
- **Callback URI:** `https://<your-domain>/api/x/callback`
- **Website URL:** `https://<your-domain>`
- Required scopes: `tweet.read tweet.write users.read offline.access`

---

## Step 5 — Pre-Deploy: Database Migration

Railway will run the build command on every deploy, but migrations must run separately. Two options:

### Option A (recommended) — Pre-deploy command on the `web` service

In `web` → **Settings → Deploy → Custom Start Command**:

```bash
bun run db:push && bun run start
```

`drizzle-kit push` is idempotent — safe to run on every deploy.

### Option B — Manual migration via Railway CLI

Run once before first traffic, then after every migration PR:

```bash
railway login
railway link          # select the ShipFlare project
railway run bun run db:push --service web
```

**First-deploy extra step:** Run the token encryption backfill once (per CLAUDE.md Security TODO):

```bash
railway run bun run scripts/encrypt-account-tokens.ts --commit --service web
```

This is idempotent — safe to re-run, but only needed once per environment after the envelope-encryption rollout. Skip it for brand-new databases with zero accounts.

---

## Step 6 — Health Checks

The MVP ships with a `/api/healthz` endpoint (Kubernetes convention — public, unauthenticated) returning `{ ok, db, redis, ts }`. Note: `/api/health` is a separate **authenticated** endpoint serving the app's health-score UI — do NOT point Railway at it.

1. In Railway's `web` service → **Settings → Networking → Health Check Path:** `/api/healthz`.
2. **Health Check Timeout:** 10 seconds (default is fine).

Railway will wait for a 200 from `/api/healthz` before routing traffic to a new deploy. On 503 (DB or Redis down), traffic keeps flowing to the previous deploy.

---

## Step 7 — BullMQ `jobId` Audit

Restarts of the worker service must NOT double-enqueue crons. Confirm every BullMQ `.add()` and `.schedule()` call sets an explicit `jobId` deterministic for the (userId, platform, period) tuple.

**Files to scan before first deploy:**
- `src/workers/index.ts` — cron scheduling block
- `src/workers/processors/*.ts` — any processor that enqueues downstream jobs
- `src/lib/queue.ts` — queue primitives

**Pattern:** Every `queue.add('name', data, { jobId })` MUST have `jobId` set. If missing, the job is treated as new and duplicates after a restart.

This audit is a one-time sanity check; any violations should be fixed with a new commit before the deploy proceeds.

---

## Step 8 — (Optional) Next.js Standalone Output

For smaller container images and faster cold starts, add this one line to `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  output: 'standalone',
  // ... existing config
};
```

This is optional but saves ~50% image size on Railway. Deploy without it first, add in a follow-up PR if cold starts feel slow.

---

## Step 9 — First Deploy

1. Push `main` (or merge the `feat/mvp-launch-ready` PR).
2. Watch both services in Railway. `web` should deploy in ~2–4 min; `worker` in ~1–2 min.
3. Tail logs: both services should print their startup banners without errors.
4. Verify health: `curl https://<your-domain>/api/healthz` should return `{"ok":true,"db":true,"redis":true,"ts":"..."}`.
5. Open the app in a browser — landing page should load with X-only copy (no Reddit references).

If anything fails, check:
- Missing env var → Railway's deploy log will name it.
- Migration error → run `railway run bun run db:push` manually against the service.
- Worker in crash loop → usually missing `REDIS_URL`, `ENCRYPTION_KEY`, or `ANTHROPIC_API_KEY`.

---

## Step 10 — Staging Environment (`dev` branch)

Split Railway into two environments for safe testing.

### Create the `dev` branch on GitHub

```bash
git checkout main
git pull
git checkout -b dev
git push -u origin dev
```

### Clone the Railway project into a staging environment

1. In Railway: **Project Settings → Environments → + New Environment**.
2. Name it `staging`, **clone from production**, then:
   - Update `staging` to watch the `dev` branch (Service → Settings → Deploy → Branch).
   - Spin up NEW Postgres + Redis addons just for staging (don't share with prod). Railway makes this easy — click **+ Database** while in the staging environment.
   - Override `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `X_REDIRECT_URI` to the staging domain.
   - Use a separate `XAI_API_KEY` with a lower quota if possible (test key vs prod key).
   - Regenerate `AUTH_SECRET` and `ENCRYPTION_KEY` for staging (different from prod).

### Deploy flow now looks like:

```
feat/* branch → PR → dev → staging env (QA click-through) → PR → main → production env
```

---

## Step 11 — GitHub Branch Protection

Configure in **GitHub repo → Settings → Branches → Add rule**:

### For `main`:
- [x] Require a pull request before merging
- [x] Require approvals: 1
- [x] Require status checks to pass: select the `CI / test` check from `.github/workflows/ci.yml`
- [x] Require branches to be up to date before merging
- [x] Require linear history
- [x] Do not allow force pushes
- [x] Do not allow deletions

### For `dev`:
- [x] Require status checks to pass: select `CI / test`
- [ ] Allow force pushes (optional; useful for rebase-heavy solo work)
- [x] Do not allow deletions

---

## Step 12 — CI/CD Deploy Job (wire after Railway is stable)

The shipped `.github/workflows/ci.yml` runs lint + typecheck + tests + build on every PR and push to `main`/`dev`. It does NOT deploy (Railway's native GitHub integration handles deploys on commit).

If you later want CI-gated deploys (production-grade; recommended once multiple people touch the repo):

1. Get a Railway API token: **Railway → Account Settings → Tokens → Create Token**.
2. Add to GitHub: **Repo Settings → Secrets → Actions → New secret** → `RAILWAY_TOKEN`.
3. Append a `deploy` job to `.github/workflows/ci.yml`:

```yaml
deploy:
  needs: test
  if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/dev'
  runs-on: ubuntu-latest
  env:
    RAILWAY_ENV: ${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
    RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
  steps:
    - uses: actions/checkout@v4
    - run: npm install -g @railway/cli
    - run: railway up --environment $RAILWAY_ENV --service web
    - run: railway up --environment $RAILWAY_ENV --service worker
```

4. In Railway: disable the native GitHub auto-deploy on `main`/`dev` (Service → Settings → Deploy → Auto-Deploy → Off). CI is now the single deploy gate.

---

## Step 13 — Post-Deploy Smoke Test

After your first successful deploy, walk through `docs/MANUAL_QA_CHECKLIST.md` end to end. Don't skip — the MVP has eleven tightly-coupled items and a regression in any one breaks the first-user experience.

---

## Rollback

If a deploy goes bad:

1. Railway → `web` service → **Deployments** tab → find the previous successful deploy → **Redeploy**.
2. Same for the `worker` service.
3. If a schema change is involved, roll forward with a compensating migration rather than backing out (Drizzle migrations are unidirectional by default).

---

## Monitoring & Alerts (post-MVP)

The MVP ships with stdout logging only. Before real user traffic:
- [ ] Wire Sentry (or equivalent) into web + worker — see TODOS.md Phase 2 "Error Monitoring".
- [ ] Set a Railway webhook to a Slack channel for deploy failures.
- [ ] Configure a simple uptime probe (BetterUptime, Cronitor) against `/api/healthz`.

---

## Reference

- **TODOS.md** section 4 — the source spec for this doc.
- **CLAUDE.md** — architecture rules that production code must respect.
- **.env.example** — authoritative list of env vars.
- **MANUAL_QA_CHECKLIST.md** — human test plan to walk after every prod deploy.
