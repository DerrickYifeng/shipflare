# MANUAL_QA_CHECKLIST.md — ShipFlare MVP Pre-Launch QA

Walk this document end-to-end against the freshly deployed production URL **before** you flip DNS or share the public link. Expect 30–60 minutes for a full pass.

**Format:** every item uses GIVEN / WHEN / THEN so you know the exact setup, the exact action, and the exact thing to observe. Tick the checkbox only when THEN is literally true in front of you — "probably works" does not count.

If anything in the **Launch Gate** section (end of doc) fails, **do not launch**. Everything else is advisory.

---

## 0. Pre-Flight

Do not start clicking through the app until every box in this section is ticked.

- [ ] **Read [DEPLOY.md](./DEPLOY.md) end-to-end first.** The QA below assumes you have already completed the Railway deploy steps and the app is reachable at a stable HTTPS URL.
- [ ] Production URL is reachable over HTTPS and serves a valid TLS certificate (no browser cert warnings).
- [ ] All environment variables from DEPLOY.md Step 4 are set on BOTH `web` and `worker` Railway services.
- [ ] `DATABASE_URL` points at the managed Postgres addon (not a local/dev DB).
- [ ] `REDIS_URL` points at the managed Redis addon (not `localhost`).
- [ ] `ENCRYPTION_KEY` is **backed up offline** — losing it makes every stored OAuth token unrecoverable.
- [ ] `AUTH_SECRET` is set and is **not** the one from `.env.test`.
- [ ] `XAI_API_KEY` is active and billed (without it `isPlatformAvailable('x')` returns false and the MVP ships dead).
- [ ] GitHub OAuth App callback URL in the GitHub settings page matches `${NEXTAUTH_URL}/api/auth/callback/github`.
- [ ] X OAuth App callback URL matches `X_REDIRECT_URI` and is HTTPS.
- [ ] `scripts/encrypt-account-tokens.ts --commit` has been run once against production Postgres (envelope-encrypts any legacy Auth.js tokens — see CLAUDE.md → Security TODO).
- [ ] Worker service logs show BullMQ connected to Redis and no `ECONNREFUSED`.
- [ ] Web service logs show Next.js booted, no uncaught exceptions on first request.

**Smoke-probe before manual QA (takes 10 seconds):**

- [ ] **GIVEN** the app is deployed, **WHEN** you run `curl -sS https://<prod-url>/api/healthz`, **THEN** the response is HTTP 200 and the JSON body is `{ok: true, db: true, redis: true, ts: "<iso>"}`. Any `false` here means stop and fix infra before QA.

---

## 1. Onboarding — Happy Path

Use a **fresh GitHub account that has never signed into ShipFlare before** (or blow away the user row in Postgres first). Use an incognito window so cookies are clean.

- [ ] **GIVEN** you are not signed in and visit `/`, **WHEN** you click the primary CTA, **THEN** a provider-picker modal appears offering GitHub (X should not appear as a sign-in provider — it is only a *connected channel*, not a sign-in option).
- [ ] **GIVEN** the provider modal, **WHEN** you click **Continue with GitHub** and approve on GitHub, **THEN** you land on `/onboarding` step 1.
- [ ] **GIVEN** onboarding step 1, **WHEN** you pick a repo from the GitHub repo list, **THEN** a code scan starts and the UI shows scan progress (no spinner stuck forever).
- [ ] **GIVEN** the code scan finishes, **WHEN** voice extraction runs, **THEN** extracted voice-profile facets appear and you can edit them. Zero 5xx errors in the Network tab.
- [ ] **GIVEN** you are on the channel-connect step, **WHEN** you click **Connect X**, **THEN** you are redirected to X's OAuth page, and after approving you land back in onboarding with the X channel row visible.
- [ ] **GIVEN** X is connected, **WHEN** onboarding completes, **THEN** you are redirected to `/today` AND the automation pipeline has auto-activated (see module 4 to verify).
- [ ] **GIVEN** you reach `/today` for the first time, **WHEN** the page loads, **THEN** within ~60s content appears (calendar items or drafts) — the first-run progress bar should animate smoothly, not freeze, and not jump discretely.

---

## 2. Onboarding — Edge Cases

- [ ] **GIVEN** you are mid-onboarding (e.g. on the voice-extract step), **WHEN** you close the tab and reopen `/onboarding` in a new tab signed in as the same user, **THEN** you resume on the same step with prior answers preserved (no forced restart).
- [ ] **GIVEN** you are signed in and onboarding is complete, **WHEN** you visit `/onboarding`, **THEN** you are redirected away (typically to `/today` or `/dashboard`) — you cannot accidentally re-enter onboarding.
- [ ] **GIVEN** GitHub OAuth returns an error (simulate by denying on GitHub), **WHEN** you are redirected back, **THEN** a friendly error page shows, no 500, and sign-in can be retried.
- [ ] **GIVEN** X OAuth returns an error (deny on X), **WHEN** you are redirected back, **THEN** the channel-connect step shows a retry CTA, no 500.
- [ ] **GIVEN** onboarding step 1 or 2, **WHEN** you click **Back**, **THEN** the previous step is re-entered with its state intact (this was commit `ff32ce5`, confirm it still works).
- [ ] **GIVEN** you are a GitHub-onboarded user, **WHEN** you visit `/settings → Product`, **THEN** the **Website** field is **empty** (not the GitHub repo URL) — we fixed code-scan from writing repo URLs into `products.url` in commit `79edc13`.

---

## 3. Reddit Is Hidden — MVP X-Only Gate

Reddit is intentionally gated off for MVP. It should **not** appear anywhere user-facing. Walk each surface and confirm.

- [ ] **GIVEN** you visit `/`, **WHEN** you read hero + features + footer copy, **THEN** the word "Reddit" does **not** appear anywhere, and claims like "Reddit + X" or "Reddit posts" are absent.
- [ ] **GIVEN** you are in onboarding at the channel-connect step, **WHEN** you inspect the available channels, **THEN** **only X** is offered — no Reddit row, no "connect Reddit" button.
- [ ] **GIVEN** you are on `/settings → Connections`, **WHEN** the page renders, **THEN** only the X channel row is visible. No Reddit row, no "Reddit (coming soon)" badge.
- [ ] **GIVEN** you are on `/today`, **WHEN** you look at draft cards and source labels, **THEN** every item shows an X/Twitter source — no `r/<subreddit>` labels, no Reddit post URLs.
- [ ] **GIVEN** you are on `/calendar`, **WHEN** you expand a calendar item, **THEN** the platform chip says `x` (not `reddit`).
- [ ] **GIVEN** you are on `/automation`, **WHEN** the Agents Warroom renders, **THEN** no agent is labelled as Reddit Discovery / Reddit Posting.
- [ ] **GIVEN** you send `GET https://<prod-url>/api/channels` (authenticated as a logged-in user via devtools fetch), **WHEN** the response returns, **THEN** `platform` values include `x` only — no `reddit` entries.
- [ ] **GIVEN** the Reddit OAuth callback URL is hit (even accidentally), **WHEN** you visit `https://<prod-url>/api/reddit/callback` directly, **THEN** the response is a redirect to `/settings?connections=reddit-coming-soon` — **not** a 500, and **not** a real OAuth handshake.

---

## 4. Automation Pipeline Auto-Activation

After onboarding completes, the pipeline should auto-enqueue discovery + calibration without the user pressing any button. This is commit `9abff8b` (Task #4).

- [ ] **GIVEN** you just finished onboarding, **WHEN** you visit `/automation`, **THEN** the pipeline status shows **Active** or **Running** (not **Paused** / **Not started**).
- [ ] **GIVEN** the pipeline is active, **WHEN** you tail the worker service logs on Railway, **THEN** you see discovery + calibration jobs being processed within ~60 seconds of onboarding completion.
- [ ] **GIVEN** the pipeline just activated, **WHEN** you visit `/today` and wait up to 2 minutes, **THEN** at least one draft card appears. Do **not** declare success until you see real content — an empty state here means auto-activation silently failed.
- [ ] **GIVEN** the pipeline is active, **WHEN** you reload `/automation` after a minute, **THEN** a `discovery_start` event and a `discovery_complete` event have been emitted and the first-run progress bar is driven by those events (commit `0e25c21` + `9d0b943`).
- [ ] **GIVEN** the pipeline is active, **WHEN** you call `GET /api/jobs/in-flight` from devtools, **THEN** you see a JSON list of jobs — zero or more, but the endpoint must return 200, not 500.

---

## 5. `/today` — First-Run UX

- [ ] **GIVEN** a fresh user just hit `/today`, **WHEN** content is still loading, **THEN** the progress bar moves smoothly (tweened), never freezes for >5 seconds, and never jumps from e.g. 20% to 80% in a single frame.
- [ ] **GIVEN** drafts are present, **WHEN** you scroll through draft cards, **THEN** each has a status pill indicating which agent drafted it (framing: "Drafted by Content Agent") — this is the approval-inbox framing.
- [ ] **GIVEN** a draft card whose body is **over** the platform char cap (X = 280 chars), **WHEN** you look at the card, **THEN** the **Approve** button is disabled, and a trim / edit CTA is shown explaining why (commit `6a42666`).
- [ ] **GIVEN** a draft card whose body is **under** the cap, **WHEN** you click **Approve**, **THEN** the action succeeds (HTTP 200, UI updates optimistically, no toast error).
- [ ] **GIVEN** you have **no X channel connected** (disconnect via `/settings` if needed), **WHEN** you view `/today`, **THEN** the **Scan Now** button is disabled and shows a "Connect X to scan" CTA (commit `d23f075`).
- [ ] **GIVEN** you have an X channel connected, **WHEN** you click **Scan Now**, **THEN** the button enters a locked / loading state, a job appears in `/api/jobs/in-flight`, and the button does not allow double-submits.
- [ ] **GIVEN** a scan is in flight, **WHEN** you navigate away and come back to `/today`, **THEN** the Scan Now button is still locked (server-truth button state, commit `3a3ce6b`).

---

## 6. `/calendar`

- [ ] **GIVEN** you are on `/calendar`, **WHEN** the list loads, **THEN** items are sorted **today → future** (ascending chronological), not descending — commit `959efba`.
- [ ] **GIVEN** you see a **Generate Week** button, **WHEN** you click it, **THEN** the button locks while the job runs.
- [ ] **GIVEN** you just clicked **Generate Week**, **WHEN** you navigate to `/today` and then back to `/calendar`, **THEN** the button is **still locked** (does not re-enable prematurely) — this is the server-truth guard (commit `d23f075`).
- [ ] **GIVEN** Generate Week completes, **WHEN** you reload `/calendar`, **THEN** new calendar items appear for the coming week and the button re-enables.
- [ ] **GIVEN** a calendar item, **WHEN** you expand it, **THEN** its platform is `x` (never `reddit`) and the content URL resolves to `https://x.com/...` or an X status URL.

---

## 7. `/settings`

### 7.1 Connections
- [ ] **GIVEN** you are on `/settings → Connections`, **WHEN** the panel renders, **THEN** **only** the X connection row is visible. No Reddit.
- [ ] **GIVEN** X is connected, **WHEN** you click **Disconnect**, **THEN** the row flips to "not connected" state and `GET /api/channels` returns an empty list for that user.
- [ ] **GIVEN** X is not connected, **WHEN** you click **Connect X**, **THEN** the X OAuth flow kicks off as in onboarding.

### 7.2 Product
- [ ] **GIVEN** you onboarded via GitHub, **WHEN** you visit `/settings → Product`, **THEN** the **Website** field is **empty** with an **Add website** CTA (commit `d8b4258`), not pre-filled with the GitHub repo URL.
- [ ] **GIVEN** the Website field is empty, **WHEN** you enter a URL and save, **THEN** the field persists across reload and `products.url` in the DB matches what you typed.

### 7.3 Voice
- [ ] **GIVEN** the Voice tab, **WHEN** it loads, **THEN** the extracted voice profile is visible and editable (no 403 on GET `/api/voice-profile` for the signed-in user — that regression was fixed in commit `579ae00`).
- [ ] **GIVEN** you edit a voice facet and save, **WHEN** you reload, **THEN** the edit persists.

### 7.4 Account
- [ ] **GIVEN** you are on `/settings → Account`, **WHEN** you click **Delete account**, confirm, and wait, **THEN** the GitHub OAuth grant is revoked (re-signing in prompts consent again, not silent re-link) and the DB cascade removes all your rows.

---

## 8. Content Correctness Smoke (critical)

ShipFlare's **core value** is that it posts non-embarrassing content. If we ship content that fabricates stats or mentions Reddit, users notice and churn. Force a draft and inspect it by eye.

- [ ] **GIVEN** you are signed in, **WHEN** you trigger a discovery + draft cycle (via **Scan Now** on `/today` or by waiting for the auto-pipeline), **THEN** at least one draft lands in `/today`.
- [ ] **GIVEN** a freshly generated draft, **WHEN** you read the body, **THEN** it contains **zero** mentions of "Reddit", "r/", "subreddit", or any Reddit-specific jargon. Content validators should have rejected/regenerated any such draft (commits `c0f0fae`, `d50fbd7`, `31553ea`).
- [ ] **GIVEN** a freshly generated draft, **WHEN** you read the body, **THEN** it contains **zero** fabricated percentage statistics (e.g. "grew 47%", "30% faster"). If numeric claims appear, they must be grounded in the user's own product context, not invented.
- [ ] **GIVEN** a reply-type draft, **WHEN** you count characters, **THEN** it is **≤ 280** (X char cap). Any over-cap draft must present a disabled Approve button + trim CTA.
- [ ] **GIVEN** a draft body, **WHEN** you read it, **THEN** it does not contain obvious LLM slop patterns: no "As an AI", no "In today's fast-paced world", no unexplained emoji bursts.

---

## 9. API & Infra Spot Checks

Do these from a terminal while the app is running.

- [ ] **GIVEN** the app is live, **WHEN** you run `curl -sS -i https://<prod-url>/api/healthz`, **THEN** HTTP 200 and body `{ok:true,db:true,redis:true,ts:...}`.
- [ ] **GIVEN** the app is live, **WHEN** you run `curl -sS -i https://<prod-url>/api/health` **without** a session cookie, **THEN** HTTP 401 (authenticated endpoint — confirm the two health routes are not mixed up).
- [ ] **GIVEN** the Reddit connect endpoint still exists as a route, **WHEN** you run `curl -sS -i https://<prod-url>/api/reddit/callback`, **THEN** you get a 302 redirect to `/settings?connections=reddit-coming-soon`. Not 500.
- [ ] **GIVEN** you are signed in, **WHEN** you fetch `/api/events` in devtools, **THEN** the SSE stream connects and emits heartbeats (no 500 in Network tab).
- [ ] **GIVEN** you are signed in, **WHEN** you fetch `/api/channels`, **THEN** you get JSON with **explicit projected fields only** — no `oauth_token_encrypted` column ever leaves the server (commit `bd65c7e`, enforced by CLAUDE.md Security TODO).

---

## 10. Device & Viewport Matrix

Open the production URL on each of the following and do a 60-second walkthrough: landing → sign in → `/today` → `/calendar` → `/settings`.

| Viewport | Device | Pass? |
|---|---|---|
| 320 px | small phone (iPhone SE) | ☐ |
| 375 px | iPhone 14 / 15 | ☐ |
| 768 px | iPad portrait | ☐ |
| 1024 px | iPad landscape / small laptop | ☐ |
| 1440 px | desktop | ☐ |
| 1920 px | large desktop | ☐ |

For each viewport verify:

- [ ] No horizontal scroll on the landing page.
- [ ] CTAs are tappable (≥ 44×44 px target) on 320 / 375.
- [ ] No text overflow out of cards on `/today` and `/calendar`.
- [ ] Nav is reachable (hamburger or fixed) at 320 / 375.
- [ ] No layout shift after hero image loads (CLS < 0.1 — eyeball test, quick flash is bad).

**Accessibility spot-checks:**

- [ ] **GIVEN** you unplug the mouse, **WHEN** you navigate the landing → sign-in → onboarding with keyboard only (Tab / Shift+Tab / Enter), **THEN** every interactive element is reachable and the focus ring is visible on each.
- [ ] **GIVEN** you enable `prefers-reduced-motion` at the OS level, **WHEN** you load `/today` and `/automation`, **THEN** the first-run progress bar and Agents Warroom respect the preference — no large swooping animations.
- [ ] **GIVEN** a screen reader or devtools accessibility pane, **WHEN** you inspect buttons like **Approve** / **Disconnect** / **Scan Now**, **THEN** each has an accessible name (either text content or `aria-label`).

---

## 11. Rollback Plan

If auto-activation or any critical pipeline step misbehaves in production, you need to stop new users from being auto-enrolled into a broken pipeline **without** taking the app down.

- [ ] **GIVEN** auto-activation is misfiring, **WHEN** you set the Railway env var controlling activation to disable (see `src/app/actions/activation.ts` and `src/workers/processors/*` for the exact flag; if no env flag exists, comment out the activation call in `activation.ts` and redeploy), **THEN** new onboardings complete but the pipeline stays paused.
- [ ] **GIVEN** a critical bug in a worker processor, **WHEN** you pause the **worker** Railway service (keep **web** running), **THEN** the web app stays up, users can still browse, but no new background jobs run. Resume when fixed.
- [ ] **GIVEN** a critical content-generation bug, **WHEN** you want to prevent auto-posting while keeping discovery running, **THEN** disable the X channel row in the DB for all users (`UPDATE channels SET enabled = false WHERE platform = 'x'`) — drafts keep generating but nothing posts.
- [ ] **GIVEN** a full rollback is needed, **WHEN** you redeploy the previous main commit on Railway (Railway → service → Deployments → previous → Redeploy), **THEN** the app reverts. Back out DB migrations only if the prior deploy's schema cannot read new data.

Document whichever lever you pulled in `#incidents` (or equivalent) immediately — including timestamp, trigger, and user impact.

---

## 12. Launch Gate — Must All Pass

Do not share the public URL or flip DNS until every item below is ticked. These are the load-bearing checks; the sections above are the walk-through.

- [ ] `/api/healthz` returns `{ok:true,db:true,redis:true}` on prod.
- [ ] CI is green on the `main` branch (lint + typecheck + tests + build).
- [ ] Onboarding happy-path (section 1) completes in under 5 minutes end-to-end.
- [ ] Auto-activation (section 4) produces at least one draft within 2 minutes of onboarding completion.
- [ ] Reddit is **not** visible on landing, onboarding, `/today`, `/calendar`, or `/settings → Connections` (section 3, all boxes).
- [ ] At least one live-generated draft passes the content correctness smoke (section 8, all boxes).
- [ ] `/api/reddit/callback` redirects to coming-soon, does not 500 (section 9).
- [ ] Settings Website field is empty by default for GitHub-onboarded users (section 7.2).
- [ ] No browser-console errors on landing, `/today`, `/calendar`, `/settings` at 375 px and 1440 px.
- [ ] `ENCRYPTION_KEY` is backed up offline.

If all boxes tick, you can launch. If even one fails, stop and route to the owning engineer before inviting any external user.
