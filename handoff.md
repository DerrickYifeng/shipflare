# Handoff: ShipFlare CF Migration — End-to-End Testing

**Session start date:** 2026-05-14
**Branch:** `feat/cf-migration-phase-2`
**Goal of new session:** Verify the Cloudflare-deployed app works end-to-end on `https://shipflare.ai`, then merge PRs and cancel Railway.

---

## TL;DR

The CF migration (Phases 0/1/2) is implemented, PRs are open (#30 + #31 stacked), and both workers are deployed. The landing page sign-in button bug was just fixed (`<a href>` → client `<button>` calling `authClient.signIn.social`). One **manual action** is required before testing: **purge the Cloudflare edge cache for shipflare.ai**.

---

## Current State

### Deployments live
| Worker | URL | Verified |
|---|---|---|
| `shipflare-web` | https://shipflare-web.cdhyfpp.workers.dev | ✅ serves new HTML (button) |
| `shipflare-web` | https://shipflare.ai | ⚠️ stale edge cache holds old HTML — purge before testing |
| `shipflare-core` | https://shipflare-core.cdhyfpp.workers.dev | needs verification |
| `shipflare-core` | https://core.shipflare.ai | **may not be bound yet** — see Step 1 below |

### Git state
- Branch: `feat/cf-migration-phase-2` (stacked on `feat/cf-migration-phase-1`)
- PR #30: phase-1 → dev (Phase 1 feature parity)
- PR #31: phase-2 → phase-1 (Phase 2 capabilities)
- **Uncommitted local changes** (sign-in fix, NOT committed yet — commit/push if test passes):
  - `M apps/core/wrangler.jsonc` (likely real D1 database_id)
  - `M apps/web/wrangler.jsonc` (likely real D1 database_id)
  - `M apps/web/app/page.tsx` (now uses `<SignInButton>` + `force-dynamic`)
  - `M apps/web/src/auth.ts` (added `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]`)
  - `?? apps/web/app/_components/sign-in-button.tsx` (new client component)
  - `?? apps/web/src/auth-client.ts` (new Better Auth react client)

### What was just fixed
1. **Landing page 404 bug**: `<a href="/api/auth/sign-in/social?provider=github">` sends GET, but Better Auth's `/sign-in/social` is POST-only. Fixed by:
   - Created `apps/web/src/auth-client.ts` — Better Auth react client (`createAuthClient()`)
   - Created `apps/web/app/_components/sign-in-button.tsx` — client component calling `authClient.signIn.social({ provider: "github", callbackURL: "/chat" })`
   - Updated `apps/web/app/page.tsx` to use the button, marked `force-dynamic`
2. **IP header warning**: Better Auth couldn't determine client IP → rate limiting fell back to "unknown". Added `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]` to `apps/web/src/auth.ts`.
3. **OpenNext stale cache**: `wrangler deploy` was reusing `.open-next/cache/<old-buildId>/` and serving old prerender HTML. Confirmed fix: `rm -rf .next .open-next && pnpm build && pnpm build:worker && pnpm exec wrangler deploy` produces correct output.

---

## Prerequisites Before Testing (do these FIRST)

### Step 1 — Verify (or set) Cloudflare secrets on `shipflare-web`

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm exec wrangler secret list
```

**Required** for sign-in / channel connect:
- `BETTER_AUTH_SECRET` (random 32+ char string)
- `BETTER_AUTH_URL` → **must be `https://shipflare.ai`** (NOT `.workers.dev`)
- `CORE_PUBLIC_URL` → `https://core.shipflare.ai` (or `https://shipflare-core.cdhyfpp.workers.dev` if domain not bound yet)
- `MCP_JWT_SECRET` (shared with `shipflare-core`)
- `CHANNEL_ENC_KEY` (32-byte base64 — shared with `shipflare-core`)
- `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`
- `X_CLIENT_ID` + `X_CLIENT_SECRET` (only if testing X channel)
- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` (only if testing Reddit)

> Note: existing GitHub-linked users must sign in once after the `public_repo` scope rollout to upgrade their stored token. Better Auth does not auto-refresh OAuth scopes; without the upgraded token the `/api/onboarding/github-repos` route can't list repos.

If any are missing or wrong:
```bash
pnpm exec wrangler secret put <NAME>
# enter value at prompt
pnpm exec wrangler deploy   # re-deploy to pick up new secrets
```

### Step 2 — Verify `shipflare-core` secrets

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/core
pnpm exec wrangler secret list
```

**Required**:
- `MCP_JWT_SECRET` (must match web)
- `CHANNEL_ENC_KEY` (must match web)
- `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` (web push)
- `ANTHROPIC_API_KEY` (or whatever LLM provider)
- `XAI_API_KEY` (for find_threads_via_xai)
- Plus any per-platform tool API keys you use

### Step 3 — Bind `core.shipflare.ai` custom domain (if not done)

CF Dashboard → Workers & Pages → `shipflare-core` → Custom Domains → Add → `core.shipflare.ai`.

If a conflicting DNS record exists for `core` subdomain, delete it first (same dance as `shipflare.ai`).

### Step 4 — Update OAuth callback URLs

| Provider | Where | Callback URL |
|---|---|---|
| GitHub | github.com → Settings → Developer settings → OAuth Apps | `https://shipflare.ai/api/auth/callback/github` |
| X | developer.x.com → Project → User authentication | `https://shipflare.ai/api/channels/x/callback` |
| Reddit | reddit.com/prefs/apps | `https://shipflare.ai/api/channels/reddit/callback` |
| LinkedIn | linkedin.com developer | `https://shipflare.ai/api/channels/linkedin/callback` |

### Step 5 — Purge CF edge cache for `shipflare.ai`

**CRITICAL — without this the landing page will still 404.**

CF Dashboard → `shipflare.ai` zone → Caching → Configuration → **Purge Everything** (or Custom Purge `https://shipflare.ai/`).

Reason: previous response had `s-maxage=31536000` (1 year) and is cached at the edge. The fix is deployed but the old HTML is stuck in CF edge.

---

## Test Plan (run in order)

### Test 1 — Landing page renders new button
```bash
curl -s https://shipflare.ai/ | grep -oE "(<button type|<a href=\"/api/auth)"
# expected: <button type
```
If you see `<a href`, edge cache wasn't purged. Repeat Step 5.

### Test 2 — Sign in with GitHub
1. Open https://shipflare.ai in browser
2. Click **Sign in with GitHub**
3. Should redirect to `github.com/login/oauth/authorize?...`
4. Authorize
5. Should land on `https://shipflare.ai/chat`

**If it fails:**
- 404 on `/api/auth/...` → BETTER_AUTH_URL secret wrong; check Step 1
- "redirect_uri mismatch" → GitHub OAuth callback URL wrong; check Step 4
- `wrangler tail` on both workers to see what's happening:
  ```bash
  cd apps/web && pnpm exec wrangler tail
  cd apps/core && pnpm exec wrangler tail   # separate terminal
  ```

### Test 3 — CMO init fires on first sign-up
After Test 2, check `wrangler tail` on `shipflare-core`. You should see:
```
POST /agents/cmo/<user-id>/internal/init  → 200
```

If it 4xx/5xx, the CMO DO isn't initializing. Look at the response body. Note: failure here doesn't block sign-in (it's fire-and-forget) — but chat will be broken without it.

### Test 4 — Chat with CMO
1. On `/chat`, type "hello" and submit
2. Should see streaming response from CMO
3. CMO is at `env.CMO.idFromName(userId)` in `apps/core` — talks to LLM via `env.AI` or whatever provider

**If empty / blocked:**
- `wrangler tail` on core
- Likely culprits: missing `ANTHROPIC_API_KEY`, MCP_JWT_SECRET mismatch between web and core, CMO not initialized

### Test 5 — Connect X channel
1. `/settings/channels` → Connect X
2. Should redirect to X OAuth, authorize, come back to `/api/channels/x/callback`
3. Channel row created in D1 with `oauthTokenEncrypted` (via `@shipflare/crypto` AES-GCM)
4. Settings page should show "X — Connected"

Verify in D1:
```bash
cd apps/web
pnpm exec wrangler d1 execute shipflare-prod --remote --command "SELECT id, platform, userId, externalUsername, createdAt FROM channels"
# tokens should NOT be in plaintext
```

### Test 6 — Trigger a sweep (full e2e)
On `/chat`: "scan reddit for ICP customers in the developer tools space"

Expected chain:
- CMO → addPlanItem(channel: 'reddit', skillName: 'discover-customers')
- Sweeper picks up → runs `discover-customers` skill
- Skill calls `reddit_search` MCP tool
- Threads inserted into D1
- Judging skill judges each → some pass
- Drafting skill drafts replies for passing threads → drafts table
- `/drafts` page shows the drafts

This is the biggest test surface; if you only have time for one beyond sign-in, do this one.

### Test 7 — Healthz endpoints
```bash
curl https://shipflare.ai/api/healthz
curl https://core.shipflare.ai/healthz
```
Both should be 200.

---

## Known Issues / Gotchas

1. **CF edge cache aggressive on prerendered pages**: `s-maxage=31536000`. Workaround: `export const dynamic = "force-dynamic"` on pages, or purge after every deploy. Landing page is now `force-dynamic`; other `(app)` routes inherit `force-dynamic` from `apps/web/app/(app)/layout.tsx` (commit `95750a9`).

2. **OpenNext stale cache**: `.open-next/cache/<old-buildId>/*.cache` is not cleaned between builds. If HTML doesn't update after deploy:
   ```bash
   cd apps/web
   rm -rf .next .open-next
   pnpm build && pnpm build:worker && pnpm exec wrangler deploy
   ```

3. **Better Auth `/sign-in/social` is POST-only**: Don't use `<a href>` links — always go through `authClient.signIn.social({...})`. Same for `signOut`.

4. **CMO init is fire-and-forget**: First sign-in spawns CMO DO via `env.CORE.fetch("https://internal/agents/cmo/<userId>/internal/init", ...)`. If this fails, sign-in still succeeds but `/chat` will appear empty. Retry happens automatically on next request to the CMO DO.

5. **Service Binding gotchas** (Phase 0 spike #8): `Host` header and `cf-connecting-ip` are stripped across service bindings. Web → core calls pass `x-shipflare-internal: 1` and a synthetic `https://internal/...` origin. Core verifies this header on `/internal/*` routes.

6. **Wrangler `vars` vs `.dev.vars`**: Use `.dev.vars` for local dev secrets; `wrangler vars` narrows types and is annoying. Production uses `wrangler secret put`.

7. **D1 database_id**: Both `apps/{web,core}/wrangler.jsonc` contain placeholder IDs in the committed file. The local working tree has real IDs (uncommitted). **Do not commit the real IDs** — keep `wrangler.jsonc` checking in the placeholder and the real one in your local edits (already the current state).

---

## If You Need to Roll Back Mid-Test

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm exec wrangler versions list
pnpm exec wrangler rollback <previous-version-id>
```

Same for `apps/core`.

If you need to roll back the whole CF migration: keep Railway alive (it should still be running). Just point shipflare.ai DNS back to Railway by:
- CF Dashboard → shipflare.ai zone → Workers Routes → remove the `shipflare.ai` route
- Add back the CNAME → `x3lkfuzg.up.railway.app` (Proxied)

---

## After Testing Succeeds

### Commit the local fixes
```bash
cd /Users/yifeng/Documents/Code/shipflare
git status   # confirm what's staged
git add apps/web/app/page.tsx apps/web/src/auth.ts apps/web/app/_components/ apps/web/src/auth-client.ts
git commit -m "fix(web): sign-in button must POST via authClient (was 404 on GET <a href>)

- Add Better Auth react client at src/auth-client.ts
- Add SignInButton client component that calls authClient.signIn.social
- Mark landing page force-dynamic to avoid year-long edge cache
- Trust cf-connecting-ip in Better Auth so rate limiter has the real IP"
git push
```

**Do NOT commit** `apps/{core,web}/wrangler.jsonc` (they contain real D1 IDs).
Stash them before any other git operations:
```bash
git stash push -- apps/core/wrangler.jsonc apps/web/wrangler.jsonc
# ... do your git work ...
git stash pop
```

### Merge PRs
1. Merge PR #30 (phase-1 → dev) using **"Create a merge commit"** (NOT squash — see memory `feedback_pr_merge_use_merge_commit.md`)
2. PR #31 will auto-rebase / update its base; merge it next via merge commit too
3. After both merge: `git checkout dev && git pull && git push origin dev:main` (fast-forward main)

### Cancel Railway
Only after 24-48h of stable production on CF. Sequence:
1. Verify no scheduled tasks / crons still on Railway that aren't ported
2. Export any data you care about (per spec: no production users, so likely nothing)
3. Railway dashboard → Settings → Cancel subscription

---

## Useful Commands Cheat Sheet

```bash
# Tail logs
cd apps/web && pnpm exec wrangler tail
cd apps/core && pnpm exec wrangler tail

# Re-deploy after env var / code change
cd apps/{web,core} && rm -rf .next .open-next && pnpm build && pnpm build:worker && pnpm exec wrangler deploy   # web
cd apps/core && pnpm exec wrangler deploy   # core (no opennext)

# Inspect D1
cd apps/web
pnpm exec wrangler d1 execute shipflare-prod --remote --command "SELECT name FROM sqlite_master WHERE type='table'"

# List secrets
pnpm exec wrangler secret list

# Bypass edge cache when curling
curl -s "https://shipflare.ai/?bust=$(date +%s%N)" | head -c 500
```

---

## Reference Files

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md` | Full design spec + Phase 1 findings sweep (§9) |
| `docs/superpowers/plans/2026-05-13-cf-phase-{0,1,2}-*.md` | Implementation plans |
| `scripts/cf-deploy-checklist.md` | Step-by-step deploy procedure |
| `scripts/deploy-cf.sh` | Deploy script |
| `apps/web/src/auth.ts` | Better Auth config |
| `apps/web/src/auth-client.ts` | Better Auth react client (NEW) |
| `apps/web/app/_components/sign-in-button.tsx` | Sign-in button (NEW) |
| `apps/web/app/page.tsx` | Landing page (force-dynamic) |
| `apps/web/app/api/auth/[...all]/route.ts` | Better Auth catch-all |
| `apps/web/app/(app)/layout.tsx` | (app) group, force-dynamic |
| `apps/{web,core}/wrangler.jsonc` | Worker configs (local has real D1 ids — don't commit) |

---

**Next session should start by:** reading this file, running Step 5 (purge cache), and running Test 1.
