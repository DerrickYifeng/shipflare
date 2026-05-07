# Real-Browser End-to-End Smoke (Manual + Playwright on Real Session)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smoke-test every meaningful user surface using the founder's REAL authenticated browser session (real GitHub/X OAuth, real product, real team, real LLM — no seeded test fixtures). Catches the class of regressions the existing seeded e2e specs miss because seeded data behaves differently from live data (e.g., today's "lead literal {productName} placeholder" + "Tool Task FK violation" both passed all unit + seeded e2e tests but broke for the founder).

**Architecture:** Two parallel modes per phase:

1. **Manual smoke checklist** — founder walks through their real Chrome, follows the checklist, eyeballs results. Authoritative because their judgment > a regex.
2. **Playwright spec on real session** — automated version of the same flow using saved `storageState` from a one-time manual login. Re-runnable for regression after every release. Skipped gracefully if `auth.json` not present.

The two modes share the SAME checklist content; only the execution differs.

**Tech Stack:** Playwright with `storageState`, real `bun run dev` instance, real Anthropic / GitHub / X / Postgres.

---

## Setup (one-time)

### A. Capture storageState from your real browser session

```bash
# 1. Make sure dev server is running on the right URL
bun run dev   # in a separate terminal

# 2. Bootstrap auth — opens a real Chromium, you sign in normally,
#    storageState saves cookies + localStorage to .auth/founder.json.
mkdir -p .auth
pnpm playwright codegen --save-storage=.auth/founder.json http://localhost:3000

# 3. In the Codegen window:
#    - click your sign-in flow (GitHub OAuth)
#    - wait until /team or /today loads with your real account
#    - close the Codegen window
#    - .auth/founder.json now contains your real session
#    - DO NOT commit this file (already in .gitignore? add to .gitignore if not)
```

Add to `.gitignore` if missing:
```
.auth/
```

### B. Add a `live-smoke` Playwright project

In `playwright.config.ts`, add a new project that uses the saved storageState:

```ts
{
  name: 'live-smoke',
  testMatch: /.*\.live-smoke\.ts/,
  retries: 0,
  timeout: 120_000,        // LLM round-trips can be slow
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    storageState: '.auth/founder.json',
    baseURL: 'http://localhost:3000',
  },
},
```

Add npm scripts to `package.json`:
```json
"test:e2e:live": "playwright test --project=live-smoke --headed",
"test:e2e:live:ci": "playwright test --project=live-smoke"
```

The `--headed` default for `test:e2e:live` is intentional — you watch your real account being driven, catch UX issues a regex can't.

### C. Conditional skip for missing storageState

Each `*.live-smoke.ts` spec begins with:

```ts
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test.skip(
  !fs.existsSync('.auth/founder.json'),
  'Run setup section A to capture storageState before running live-smoke specs',
);

test.describe.configure({ mode: 'serial' });  // share the same session
```

This way `pnpm test:e2e` (the existing full suite) doesn't break when the auth file isn't present — only `test:e2e:live` runs the live smokes.

---

## Pre-flight context

- **Fresh onboarding IS in scope** — you're willing to delete your account and redo it. See **Phase 0.5** below. Run it BEFORE the storageState capture (Section A above) so the saved session reflects post-onboarding state. The order is: Phase 0.5 (delete + redo onboarding) → Section A (capture storageState from the newly onboarded session) → Section B + C → Phases 1–7.
- **Live LLM costs.** Each phase that sends a real message to the team-lead spawns real Anthropic API calls. Budget ~$0.05–0.30 per full-suite live-smoke run. Don't run it on every commit; run it before each push to remote and after every "this might have regressed something" change.
- **Test pollution.** Live smokes write real data to your DB (drafts, agent_runs, team_messages). The plan's phases either (a) use side-effect-free flows (read-only checks) where possible, or (b) tag created data with a `[smoke]` prefix in user-visible content so you can grep + delete it post-run.
- **Failure surface.** When a phase fails, the failing screenshot lands in `test-results/`. Inspect there before re-running.

---

## Phases

Each phase is one task. Tasks are ordered by user-journey priority — run earlier phases first. Each phase has BOTH a manual checklist and a Playwright spec; they cover the same ground.

---

### Phase 0.5: Fresh onboarding (destructive — delete + redo your account)

**Why:** today's morning bug class (`write_strategic_path: product null not found`) was a fresh-onboarding crash that no existing test caught. The user's existing seeded `onboarding.spec.ts` is a visual regression test — it screenshots stage layouts but doesn't drive real LLM through the plan-generation flow. **This phase is the actual end-to-end smoke that would have caught the regression.**

**⚠️ DESTRUCTIVE.** This phase deletes all your account data:
- Your `users` row + everything that cascades (team, agent_runs, team_messages, drafts, plan_items, channels, products, strategic_paths)
- Your X channel OAuth grant (you'll re-authorize during onboarding)
- Your GitHub OAuth grant (Auth.js stores this in `accounts`; gets re-prompted on next sign-in)
- Anything else FK'd to your `userId`

**Before running:** confirm there's no production data you need to keep. This is OK in dev because you're the only user.

**Spec file:** `e2e/tests/onboarding-fresh.live-smoke.ts`

**Manual checklist:**

#### Step 1: Delete your account
- [ ] Open `/api/account` DELETE flow if exposed in UI (check `/settings` for an "Delete account" button), OR run SQL directly:
  ```sql
  -- replace with your actual user id (from `select id, email from users where email = 'cdhyfpp@gmail.com'`)
  DELETE FROM users WHERE email = 'cdhyfpp@gmail.com';
  ```
  This cascades through every FK that uses `onDelete: 'cascade'` — your team, agent_runs, drafts, etc. all go.
- [ ] Optional: revoke your X / GitHub OAuth grants from their respective developer dashboards so the next sign-in re-prompts the consent screen (cleanest test). The `feat/security-hardening` work shipped a `DELETE /api/account` that already revokes the GitHub grant — if you went through the UI route, this is automatic.
- [ ] Verify clean slate: `select count(*) from users where email = 'cdhyfpp@gmail.com'` returns 0.

#### Step 2: Sign in fresh
- [ ] Navigate to `http://localhost:3000`. Should see the marketing landing or sign-in modal.
- [ ] Click **Sign in with GitHub**. OAuth round-trip happens; consent screen appears (if revoked).
- [ ] Authorize. Land on `/onboarding/source` (or `/onboarding` — verify the actual entry).

#### Step 3: Stage 1 — Source extraction
- [ ] Paste a website URL OR pick a GitHub repo. Click **Extract**.
- [ ] **Within 30s**: extracted product info renders (name, description, category, target audience, keywords).
- [ ] Worker log: NO `Tool ... failed` errors.
- [ ] Verify the extracted info matches your real product (sanity).

#### Step 4: Stage 2 — Review + edit
- [ ] Edit any field (e.g., shorten description). Click **Continue / Next**.
- [ ] Verify navigation to stage 3 (plan generation).

#### Step 5: Stage 3 — Plan generation (the bug-prone surface)
- [ ] **Watch the SSE progress carefully.** Each `tool_progress` event should render in the UI as a step ("query_strategic_path → write_strategic_path → done" or similar).
- [ ] **Within 60-120s**: strategic path renders with:
  - Narrative paragraph
  - 3-5 milestones with `atDayOffset` + titles
  - Thesis arc rows for the next 3-4 weeks
  - Content pillars (3-7 items)
  - Channel mix (X / Reddit settings)
  - Phase goals
- [ ] **CRITICAL**: NO error toast like "planner_timeout" / "product null not found" / "strategic_paths row not found for pathId". This is the bug class today's `19436f6` fixed.
- [ ] Worker log tail: NO `write_strategic_path failed` warnings.
- [ ] DB sanity (in psql): `select id, name from products where user_id = '<your-id>'` returns exactly 1 row (not zero — the bug — and not duplicate).

#### Step 6: Stage 3 — Edit the path (optional)
- [ ] If your UI exposes editing the path before commit, edit one field (e.g., a milestone title). Verify the edit persists in the next view.

#### Step 7: Stage 4 — Commit
- [ ] Click **Commit** / **Looks good, continue**.
- [ ] **Within 10s**: redirect to `/team` (or `/today`).
- [ ] Worker log: see `commit done user=... product=... planId=... enqueued=[...]`.
- [ ] DB sanity:
  - `products.onboardingCompletedAt` is set (not null) for your row.
  - `strategic_paths` has 1 active row for your user.
  - `plans` table has 1 row for this week (`trigger='onboarding'`).
  - `plan_items` has at least one `content_post` and/or `content_reply` row scheduled this week.
  - `teams` has 1 row for you with `productId` set.
  - `team_members` has the coordinator + at least content-manager + discovery-agent rows.

#### Step 8: First team-page render
- [ ] Land on `/team`. The lead is sleeping (status pill: `sleeping` or implicit "ready").
- [ ] Watch for `team-kickoff` to enqueue (worker log: `enqueueAgentRun ... lead trigger=kickoff`). Within ~30s of landing, the lead wakes and produces an opening message.
- [ ] **Verify the opening message references your real product** (NOT `{productName}`).

#### Step 9: Capture storageState NOW
- [ ] Setup section A above: `pnpm playwright codegen --save-storage=.auth/founder.json http://localhost:3000`. Codegen opens; you click around briefly to confirm the session works; close. Now `.auth/founder.json` reflects the post-onboarding session and Phases 1–7 can run against it.

**Playwright spec (sketch):** the spec doesn't cover account deletion (manual SQL preferred — too risky to automate). It assumes you've just signed in fresh and lands on `/onboarding/source`. Then it drives steps 3–7 and asserts the canary signals.

```ts
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test.skip(
  !fs.existsSync('.auth/founder-fresh.json'),
  'Run Phase 0.5 step 1 + 2 manually first, then capture .auth/founder-fresh.json BEFORE onboarding',
);

test('[smoke] fresh onboarding completes end-to-end without write_strategic_path crash', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await page.goto('/onboarding/source');

  // Stage 1 — paste a website URL (use your real one or a stable test one).
  await page.getByPlaceholder(/website|url/i).fill('https://shipflare.dev');
  await page.getByRole('button', { name: /extract|next/i }).click();

  // Wait for extracted info to render.
  await expect(page.getByText(/category|target audience/i)).toBeVisible({ timeout: 30_000 });

  // Stage 2 — accept defaults, continue.
  await page.getByRole('button', { name: /continue|next/i }).click();

  // Stage 3 — plan generation. Wait for the SSE-streamed strategic path.
  // Look for a known section (narrative, milestones, etc.).
  await expect(page.getByText(/milestones|content pillars|thesis arc/i))
    .toBeVisible({ timeout: 120_000 });

  // Anti-regression: no error toast, no literal placeholders.
  const allText = await page.locator('body').innerText();
  expect(allText).not.toMatch(/planner_timeout|product null not found|strategic_paths row not found/);
  expect(allText).not.toMatch(/\{productName\}|\{currentPhase\}|\{itemCount\}/);

  // Stage 4 — commit.
  await page.getByRole('button', { name: /commit|looks good|continue/i }).click();

  // Land on /team.
  await expect(page).toHaveURL(/\/(team|today)/, { timeout: 30_000 });

  // No console errors during the whole flow.
  expect(
    consoleErrors.filter((e) => /Tool .* failed|Missing dependency/i.test(e)),
  ).toHaveLength(0);
});
```

**Cost:** this phase fires real Anthropic for plan generation (~$0.10–0.30 per run). Run rarely — maybe once per release candidate or after any onboarding-flow change.

**Cleanup:** none — you're already in a fresh state, that IS the new clean slate.

---

### Phase 1: Team chat — first message + grounded response

**Why first:** the highest-risk regression class today (lead's tool-call surface, prompt substitution, tool deps wiring). All four of today's morning bugs surfaced here.

**Spec file:** `e2e/tests/team-chat.live-smoke.ts`

**Manual checklist:**

- [ ] Open `http://localhost:3000/team` in your real Chrome (already authenticated).
- [ ] Verify roster panel renders with your team-lead (Chief of Staff) visible.
- [ ] In the composer at the bottom, type: `"[smoke] What's my current strategic phase and how many plan items are scheduled this week?"` Hit send.
- [ ] **Within 30s**: see at least one **tool-call activity card** appear (look for `query_strategic_path` or `query_plan_items` — these are the lead's strategy/plan reads).
- [ ] **Verify the response text is grounded** in your real product:
  - Mentions your product name (NOT the literal string `{productName}`)
  - Mentions your real strategic phase (`launch` / `audience` / etc., NOT `{currentPhase}`)
  - Cites a real number for plan items (NOT `{itemCount}`)
- [ ] No "测试环境中运行" / "数据库上下文还没有完全注入" / "Missing dependency" excuses. (Today's morning bug class.)
- [ ] Worker log: tail `bun run dev` console — verify NO `Tool ... failed` warnings during the response.

**Playwright spec:**

```ts
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

test.skip(
  !fs.existsSync('.auth/founder.json'),
  'Run setup section A to capture storageState before running live-smoke specs',
);
test.describe.configure({ mode: 'serial' });

test('[smoke] team chat — first message produces grounded response with tool cards', async ({ page }) => {
  // Capture worker errors via console.
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/team');
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });

  // Type the smoke prompt + send.
  const composer = page.getByPlaceholder(/send a message|message your team/i);
  await composer.fill(
    "[smoke] What's my current strategic phase and how many plan items are scheduled this week?",
  );
  await composer.press('Enter');

  // Wait for at least one tool-call activity card to appear.
  // Selector pattern matches your conversation-reducer's tool_call rendering.
  await expect(page.getByText(/query_strategic_path|query_plan_items|query_team_status/i))
    .toBeVisible({ timeout: 30_000 });

  // Wait for the lead's text response to settle.
  // Heuristic: wait for any message that's NOT the user's prompt + has > 50 chars.
  await page.waitForTimeout(15_000);
  const messages = await page.locator('[data-message-role="assistant"], .message-assistant').allTextContents();
  const longResponses = messages.filter((m) => m.length > 50);
  expect(longResponses.length).toBeGreaterThan(0);

  // Anti-regression: response must not contain literal placeholder strings.
  const allText = longResponses.join('\n');
  expect(allText).not.toMatch(/\{productName\}|\{currentPhase\}|\{itemCount\}|\{TEAM_ROSTER\}/);
  expect(allText).not.toMatch(/数据库上下文还没有完全注入|测试环境中运行|Missing dependency/);

  // No tool errors in console.
  expect(
    consoleErrors.filter((e) => /Tool .* failed|Missing dependency/i.test(e)),
  ).toHaveLength(0);
});
```

---

### Phase 2: Team chat — delegation (Task spawn + task_notification)

**Why:** today's afternoon bug class — `team_tasks` FK violation when the lead invokes Task to spawn a teammate. Closed by the team_runs drop, but should be smoked.

**Spec file:** `e2e/tests/team-delegation.live-smoke.ts`

**Manual checklist:**

- [ ] In `/team`, send: `"[smoke] Draft me 2 X posts about the product launch using my strategic path. I need them in the next minute."`
- [ ] **Within 60s**: see a `Task` tool-call card appear in the activity feed (lead delegating to content-manager or similar).
- [ ] Verify a **teammate row appears in the roster panel** (left side) with a status pill showing `running` or `working`.
- [ ] **Within 90s**: see the teammate's row transition to `completed` status. A `task_notification` card should arrive in the chat thread.
- [ ] Open `/today` (without dismissing the chat) — verify the 2 drafts appear in the drafts list within ~10s.
- [ ] Worker log: NO `Tool Task failed` / `Failed query` errors during the spawn or completion.
- [ ] DB sanity (optional, in psql or your DB UI): `select count(*) from team_tasks where description ilike '%smoke%' and started_at > now() - interval '5 minutes'` returns 1.

**Playwright spec:** as above, asserts (a) Task card appears, (b) roster row count increases, (c) drafts visible at /today within timeout, (d) no FK error in console.

---

### Phase 3: Today page — drafts surface + approval flow

**Why:** mid-session content-management; affected indirectly by today's runId-write changes.

**Spec file:** `e2e/tests/today-drafts.live-smoke.ts`

**Manual checklist:**

- [ ] Open `/today`.
- [ ] Verify the 2 drafts from Phase 2 are visible (look for `[smoke]` substring in the body, OR just verify the latest 2 drafts).
- [ ] Click **Approve** on one of them.
- [ ] Verify the draft transitions to `scheduled` status (or `posted` if your auto-post is enabled).
- [ ] **DO NOT click approve on the second one if it'd actually post to X** — leave it for cleanup.
- [ ] Refresh the page. Verify the approved one persists in `scheduled` state, the other stays in `drafted`.

**Playwright spec:** auth + navigate + assert visibility + click Approve + assert state transition.

---

### Phase 4: Plan page — view + manual ops

**Spec file:** `e2e/tests/plan-page.live-smoke.ts`

**Manual checklist:**

- [ ] Open `/plan`.
- [ ] Verify your strategic_path renders (narrative, milestones, thesis arc, content pillars, channel mix).
- [ ] Verify the plan_items table renders with this week's items (kind, channel, scheduledAt, status).
- [ ] Click "Edit" on one plan item, change its `description`, save. Verify the change persists on refresh.
- [ ] Click "Add plan item" (if exposed in UI) → fill out a minimal item with `[smoke]` prefix → save. Verify it appears.

**Playwright spec:** navigate + content assertions + small edit operation.

---

### Phase 5: Admin observability — per-request view

**Why:** verify today's `/admin/team-runs` migration end-to-end (we added a Playwright smoke for this in `admin-team-runs.spec.ts` but that uses seeded data; this is the live version against your real session).

**Spec file:** `e2e/tests/admin-team-runs.live-smoke.ts`

**Manual checklist:**

- [ ] Sign in as your admin email (verify you have admin access — `ADMIN_EMAILS` env var should include yours).
- [ ] Open `/admin/team-runs`.
- [ ] Verify the request list renders with at least 2 rows (the messages you sent in Phase 1 + Phase 2).
- [ ] Verify each row shows: `Trace` (truncated requestId), `goal` (your message text excerpt), `ownerEmail` (your email), `startedAt`, `completedAt`, `status` (completed), `totalTurns` (>0).
- [ ] Click into the most recent row. Verify the detail page renders with:
  - Header (request goal, owner, team, status, duration)
  - Activity timeline (assistant_text + tool_call + tool_result rows in chronological order)
  - team_tasks breakdown (per-spawn cost/turn rows from Phase 2's delegation)
- [ ] Click back. Filter by `?sinceDays=1` (URL bar). Verify only today's requests show.

**Playwright spec:** navigate + row presence + drill-in + back-link + filter.

---

### Phase 6: Negative paths

**Spec file:** `e2e/tests/team-chat-negative.live-smoke.ts`

**Manual checklist:**

- [ ] **Cancel a teammate mid-flight:** send a message likely to spawn a teammate (e.g. `"[smoke] Run a deep discovery scan for X reply targets, max 20 results."`). When the teammate row appears, click its **Cancel** button. Verify status transitions to `cancelled` / `killed` within ~10s. No retries fire.
- [ ] **Drawer state stability** (today's lint fix): open the transcript drawer for teammate A. Close it. Open the drawer for teammate B (or the lead). Verify NO flash of teammate A's messages.
- [ ] **Page refresh mid-session:** while a long teammate is running, refresh `/team`. Verify the roster repopulates with the running teammate still visible. The chat thread loads from history.
- [ ] **SSE reconnection:** disconnect Wi-Fi for 30s, reconnect. Verify SSE re-subscribes (look at network panel in DevTools — the `team:.../messages` EventSource should reconnect automatically).

**Playwright spec:** drives the cancel + drawer-switch flows; the network-disconnect case is hard to automate, leave as manual-only.

---

### Phase 7: Settings + account

**Spec file:** `e2e/tests/settings.live-smoke.ts`

**Manual checklist:**

- [ ] Open `/settings`.
- [ ] Verify connected channels render (X, Reddit, etc.) with their @username display.
- [ ] Verify weekly budget setting renders (currently stubbed to `spentUsd: 0` per today's team-budget cleanup — that's a known display state, not a bug).
- [ ] Click "Disconnect" on a non-critical channel → confirm modal → verify channel removed from list. RECONNECT IT IMMEDIATELY (or use a throwaway test channel) so your team-lead's real-life context doesn't get stripped.
- [ ] Send a new chat message to the lead and verify its response no longer references the disconnected channel (i.e., `{channels}` substitution reflects current state, NOT cached).

**Playwright spec:** read-only assertions; skip the disconnect/reconnect dance in automation (too risky).

---

## Execution

### When to run each phase

| When | Run |
|---|---|
| Before pushing a backend change to remote | Phase 1 + 2 + 5 (10 mins, ~$0.20 LLM cost) |
| After UI work in `/team` or `/today` | Phase 1 + 2 + 3 + 6 (15 mins) |
| After a schema migration | Phase 1 + 2 + 5 (verify no FK regressions) |
| After ANY change touching `/api/onboarding/*` or `generating-strategy` skill | **Phase 0.5** (~5 mins, ~$0.20 LLM cost; destructive — your account gets recreated) |
| Before tagging a release | All 8 phases (45 mins, ~$0.70). Phase 0.5 first since it resets your account. |
| After every dev session ends | Phase 1 only (sanity-smoke that the lead still works at all) |

### Running

```bash
# Manual mode — open your real Chrome, follow the checklist:
bun run dev    # if not already running
# then walk through each phase by hand

# Playwright mode — automated, headed (you watch):
pnpm test:e2e:live -- e2e/tests/team-chat.live-smoke.ts

# Run all live-smokes:
pnpm test:e2e:live

# CI / unattended:
pnpm test:e2e:live:ci
```

### Cleanup

After a smoke session, clean up the test artifacts:

```sql
-- Delete drafts created with [smoke] prefix in the last 1 hour
DELETE FROM drafts WHERE body ILIKE '%[smoke]%' AND created_at > now() - interval '1 hour';

-- Delete plan_items added with [smoke] prefix
DELETE FROM plan_items WHERE description ILIKE '%[smoke]%' AND created_at > now() - interval '1 hour';

-- (Don't delete team_messages or agent_runs — they're useful history)
```

---

## Implementation tasks (when you decide to dispatch)

This plan deliberately does NOT pre-create all 7 spec files. Each phase is a separate sub-task that can be dispatched independently. Pick the order based on coverage priority — I recommend **Phase 1 first** (highest-value smoke) and add others incrementally.

For each phase you want shipped:
1. Dispatch an implementer to create the spec file at `e2e/tests/<phase-name>.live-smoke.ts`.
2. Implementer's deliverable: spec file + a 1-line npm script update if needed.
3. Implementer runs the spec **headed** with the founder's `.auth/founder.json` to confirm it actually drives the real session correctly.
4. Two-stage opus review per usual.
5. Commit on worktree branch, ff-merge after approval.

The setup (Section A + B + C) should land FIRST — that's a one-time enabler for all subsequent phases. Treat it as Phase 0.

---

## Self-review checklist

- [x] Real-browser focus — uses founder's actual storageState, not seeded fixtures.
- [x] Manual checklist + Playwright spec for every phase (per the new feedback rule).
- [x] Each phase scoped to a single user journey for clear failure isolation.
- [x] Cost + cleanup explicit (LLM cost ~$0.05–0.30/run; SQL cleanup snippets).
- [x] Skip-gracefully behavior when storageState absent (so `pnpm test:e2e` doesn't break).
- [x] Phase ordering by user-journey priority + by risk (Phase 1 catches today's morning bug class).
- [x] Doesn't cover fresh-onboarding (you're already onboarded; existing seeded `onboarding.spec.ts` covers that surface).
- [x] Worktree-branch commit reminder for sub-task implementations.
- [x] No new infrastructure beyond the `live-smoke` Playwright project + storageState helper.
