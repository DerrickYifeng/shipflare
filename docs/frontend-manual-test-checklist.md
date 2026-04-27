# Frontend Manual Test Checklist — ShipFlare v3 AI Team Platform

Covers every user-facing feature shipped in Phase D (`/team` UI), Phase F (Meet-your-team card), and Phase G (admin dashboard). Go through tests in order — earlier tests set up state later tests depend on.

**Estimated time**: 45-60 minutes for full pass.

---

## 0. Prerequisites

Before starting:

- [ ] Repo on branch `dev` at tag `tool-layout-aligned` or later
- [ ] `pnpm install` run
- [ ] `.env.local` has valid `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `AUTH_SECRET`
- [ ] Postgres is running and migrated: `pnpm db:push` or `pnpm db:migrate`
- [ ] Redis is running on `:6379` (or whatever `REDIS_URL` points at)
- [ ] Start the dev server: `pnpm dev` — should start on `http://localhost:3000`
- [ ] Start the worker: `pnpm worker` (in a separate terminal) — handles BullMQ team-run jobs
- [ ] Browser DevTools open on the Network tab (to watch SSE streams)

**Test accounts to create**:
- `testuser@example.com` — regular user
- `admin@example.com` — put this email in `ADMIN_EMAILS` env var (comma-separated), restart dev server

---

## Test 1 — /team page: empty state

**Purpose**: verify the page loads cleanly for a user with no team yet and routes correctly.

1. [ ] Open a fresh incognito window
2. [ ] Sign in as `testuser@example.com` (complete OAuth or magic-link flow)
3. [ ] Skip onboarding or land on `/today` dashboard
4. [ ] Navigate to `http://localhost:3000/team`

**Expected**:
- [ ] Page renders without errors
- [ ] Shows empty-state message: "Your team is ready. Ship your first plan to get started." (or similar)
- [ ] CTA button/link points to `/onboarding`
- [ ] No console errors in DevTools
- [ ] Page uses the standard (app) layout — same sidebar/header as `/today`

**Fail signals**: 500 error, blank page, stack trace in console, missing layout shell.

---

## Test 2 — Onboarding "Meet your team" card

**Purpose**: verify the Phase F preview card on onboarding Stage 7.

1. [ ] Stay signed in as `testuser@example.com`
2. [ ] Navigate to `/onboarding` (start fresh onboarding if needed)
3. [ ] Progress through stages until you reach **Stage 7** (the plan stage, last stage)

**Expected on Stage 7**:
- [ ] "Meet your team" section is visible alongside the plan
- [ ] Shows **3-5 member preview cards** side-by-side (grid)
- [ ] Each card has: display name (e.g. "Chief of Staff", "Head of Growth", "Head of Content") + role subtitle + colored avatar/gradient
- [ ] Copy reads something like: "Your team is ready to launch. They'll start working the moment you approve your first plan."
- [ ] **No add/remove/rename buttons** visible — purely read-only
- [ ] Member composition matches the product category:
  - `dev_tool` → 5 members incl. x-writer + community-manager
  - `saas` or `ai_app` → 5 members incl. x-writer + community-manager
  - `consumer` → 5 members incl. reddit-writer + community-manager (falls back to x-writer if no Reddit channel connected)
  - `creator_tool`, `agency`, `other`, or no category → 4 members incl. x-writer

**Fail signals**: fewer than 3 cards, add/remove buttons present, wrong member types, card missing display_name.

---

## Test 3 — Complete onboarding → team auto-provisioned

**Purpose**: verify `provisionTeamForProduct` hook fires on commit.

1. [ ] Click "Ship it" / "Commit plan" / the final onboarding action
2. [ ] Wait for the commit to succeed (redirects to `/today`)

**Verify via browser**:
- [ ] Navigate to `/team`
- [ ] Team grid renders with 3-5 member cards (matches the Meet-your-team preview from Test 2)
- [ ] Each card shows: display name, agent_type subtitle, status badge (should be `idle` initially), "Last active: never" or blank
- [ ] Team header shows team name + "Your team hasn't started yet" or similar, cost = $0.00

**Verify via DB** (optional, in psql):
```sql
SELECT id, user_id, product_id, name FROM teams WHERE user_id = '<testuser-uuid>';
SELECT agent_type, display_name, status FROM team_members WHERE team_id = '<teamid>';
```
- [ ] Exactly one `teams` row with non-null `product_id`
- [ ] 3-5 `team_members` rows matching the preset

**Fail signals**: no team created, two teams (product_id null AND product_id populated — the relink bug), wrong member count, display_name missing.

---

## Test 4 — Trigger a team run, watch SSE

**Purpose**: verify real-time SSE streaming on `/team/[memberId]` via `useTeamEvents`.

1. [ ] Stay on `/team` after Test 3
2. [ ] Open DevTools Network tab → filter for "EventStream"
3. [ ] Click on the **coordinator** (Chief of Staff) member card — lands on `/team/[memberId]`
4. [ ] In another tab, trigger a run. Easiest ways:
   - Re-plan: `/today` page → "Re-plan this week" button
   - Or via API (use Postman or `curl`):
     ```bash
     curl -X POST http://localhost:3000/api/team/run \
       -H "Cookie: <your-session-cookie>" \
       -H "Content-Type: application/json" \
       -d '{"teamId":"<teamid>","goal":"Plan a test post","trigger":"manual"}'
     ```

**Expected on member detail page**:
- [ ] DevTools shows an open EventStream connection to `/api/team/events?teamId=...`
- [ ] Status pill at the top reads "Live" (green) after connection establishes
- [ ] Activity log populates with messages in order: `user_prompt` → `tool_call` (Task) → `tool_result` → `agent_text` → etc.
- [ ] Message types render distinctly:
  - `user_prompt`: styled as user message
  - `agent_text`: plain message from the agent
  - `tool_call`: shows tool name + collapsible input JSON
  - `tool_result`: collapsible output; `is_error=true` styled on error-tinted surface
  - `thinking`: hidden by default; toggle "Show thinking" to reveal
  - `completion` / `error`: terminal markers
- [ ] Threaded view: nested tool_calls (e.g. when coordinator spawns growth-strategist via Task) appear **indented** with "via <agentName>" byline
- [ ] Coordinator's member card on `/team` now shows status `active` (you may need to refresh `/team` in another tab to see it)

**Fail signals**: SSE connection drops immediately, no messages stream in, activity log stays empty, wrong message ordering, tool_calls not collapsible.

---

## Test 5 — SSE reconnection with jitter backoff

**Purpose**: verify `useTeamEvents` reconnection logic.

1. [ ] Stay on the member detail page from Test 4 (SSE connected)
2. [ ] In DevTools Network tab, right-click the EventStream request → "Block request domain" (or stop the dev server briefly)

**Expected**:
- [ ] Status pill changes to "Reconnecting..." (amber/warning color) within 1-2s
- [ ] Activity log keeps existing messages — does NOT clear
- [ ] Reconnection attempts space out with jitter (watch Network tab — you'll see retries at ~1s, ~2s, ~4s, ~8s, capped at ~30s)
- [ ] No browser tab freeze, no infinite loop of requests

Then unblock the request / restart dev server:
- [ ] Status pill returns to "Live" within 1-2s
- [ ] New messages resume streaming
- [ ] No duplicate messages (dedupe by id works)

**Fail signals**: thundering-herd pattern (retries every few ms), pill doesn't update, messages duplicate on reconnect.

---

## Test 6 — Direct message form → live injection

**Purpose**: verify the send-message-form posts to `/api/team/message` and the coordinator receives the injection mid-run.

1. [ ] Start a new team run (same as Test 4). Watch the activity log.
2. [ ] Before the run completes (while status is `active`), scroll to the send-message-form **below the activity log**
3. [ ] Check the placeholder text — it should be **role-aware**:
   - On coordinator page: "Ask Chief of Staff to replan this week…"
   - On growth-strategist page: "Direct the growth strategist to rewrite the thesis…"
   - On content-planner page: "Tell the content planner what to slot in next…"
4. [ ] Type a message: `"Please note: this is a test injection — keep going."`
5. [ ] Check the **character counter** at the bottom right — shows `30 / 500` or similar
6. [ ] Try typing past 500 chars — submit disables + counter turns red past 500
7. [ ] Trim back under 500 and **press ⌘/Ctrl+Enter** (or click submit button)

**Expected**:
- [ ] Pending state shows (button disabled, spinner or "Sending…" text)
- [ ] Success toast: "Message sent to Chief of Staff" or similar
- [ ] Form clears
- [ ] A new `user_prompt` message appears in the activity log within 1-2s (via SSE)
- [ ] On the coordinator's **next turn** (watch activity log), the coordinator references your message in its thinking or reply (e.g. "I see you asked me to note that — will continue…")

**Fail signals**: form doesn't submit, toast doesn't appear, message never reaches activity log, coordinator doesn't acknowledge the injection.

**Error path** — test error handling:
1. [ ] Stop the dev server mid-submit
2. [ ] Retry the form submission (same message)
3. [ ] Expected: inline error + toast, **form preserves draft content** (doesn't clear)

---

## Test 7 — Admin pages: non-admin access blocked

**Purpose**: verify `ADMIN_EMAILS` guard hides admin routes from regular users.

1. [ ] Stay signed in as `testuser@example.com` (NOT in `ADMIN_EMAILS`)
2. [ ] Navigate to `http://localhost:3000/admin/team-runs`

**Expected**:
- [ ] Page returns **404 (not found)** — intentional, hides the admin surface
- [ ] NOT 403 or a "forbidden" message (that leaks the page's existence)

3. [ ] Navigate to `http://localhost:3000/admin/team-runs/<some-uuid>`
- [ ] Also 404

**Fail signals**: page renders for non-admin, shows 403, redirects to login.

---

## Test 8 — Admin pages: admin list view

**Purpose**: verify `/admin/team-runs` list page functions.

1. [ ] Sign out as testuser
2. [ ] Sign in as `admin@example.com` (must be in `ADMIN_EMAILS`)
3. [ ] Navigate to `http://localhost:3000/admin/team-runs`

**Expected**:
- [ ] Page loads with a table of recent team_runs (last 100)
- [ ] Columns: `team` (or teamId), `trigger`, `status`, `startedAt`, `duration`, `totalCostUsd`, `turns`
- [ ] Filter bar visible with: status dropdown, team filter, min-cost input, since-days input
- [ ] Default view shows runs from last 30 days (or similar)

**Filter tests**:
- [ ] Click status filter → set to `completed` → URL updates with `?status=completed` → table refilters
- [ ] Set min-cost to `0.01` → URL updates → table filters
- [ ] Set since-days to `7` → filters last week
- [ ] Clear filters — table returns to default

**Click-through**:
- [ ] Click any run row → navigates to `/admin/team-runs/[runId]`

**Fail signals**: no rows shown (when runs exist), filters don't update URL, filters don't actually filter, click-through fails.

---

## Test 9 — Admin pages: admin detail view

**Purpose**: verify `/admin/team-runs/[runId]` detail page.

1. [ ] From the list view, click a completed run

**Expected**:
- [ ] **Run header section**: team name, trigger, status, duration, total cost, turns
- [ ] **Spawned tasks table**: one row per `team_tasks` entry. Columns: agent name, description, cost_usd, turns, duration, status
- [ ] **Cost breakdown**: per-agent cost total should equal `team_runs.total_cost_usd` (verify sum in browser)
- [ ] **Message timeline**: full `team_messages` list in chronological order with from/to/type/content
- [ ] Tool_call and tool_result messages have expandable metadata (click to expand JSON)
- [ ] `thinking` messages are visible (admin view doesn't hide them like user view)
- [ ] Errors in the timeline tinted red

**Fail signals**: empty task table, cost mismatch (total doesn't equal sum of children — this caught the aggregation bug in Phase G), timeline missing messages, expand doesn't work.

---

## Test 10 — Budget auto-pause

**Purpose**: verify `SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE` blocks Task tool when budget exhausted.

1. [ ] In psql, set a test team's budget very low:
   ```sql
   UPDATE teams SET config = jsonb_set(config, '{weeklyBudgetUsd}', '0.01')
   WHERE id = '<your-teamid>';
   ```
2. [ ] Trigger a team run that would delegate (e.g. onboarding — coordinator spawns growth-strategist)
3. [ ] Watch the activity log on the coordinator's page

**Expected**:
- [ ] Coordinator's first delegation attempt via Task → **error tool_result** with message like "Team weekly budget reached. Budget resets Monday 00:00 UTC."
- [ ] Coordinator can still use **query_*** tools, **SendMessage**, **add_plan_item** — only Task is blocked
- [ ] Run completes with a message from coordinator explaining the budget stop
- [ ] An email warning was logged (check server logs for `observability:budget-90pct` or `observability:budget-100pct`)

4. [ ] Verify opt-out flag works:
   ```bash
   # stop dev server, then:
   SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE=false pnpm dev
   ```
- [ ] Re-trigger the run → Task succeeds despite low budget (feature flag disabled it)

5. [ ] Restore normal budget:
   ```sql
   UPDATE teams SET config = jsonb_set(config, '{weeklyBudgetUsd}', '5')
   WHERE id = '<your-teamid>';
   ```

**Fail signals**: Task call goes through despite exhausted budget, wrong error message, other tools also blocked, feature flag ignored.

---

## Test 11 — Channel-connect → silent member add

**Purpose**: verify connecting a new platform channel silently adds the matching writer to the team.

1. [ ] As testuser (with a `default-squad` team that does NOT have Reddit connected)
2. [ ] Note the current team members (should be coordinator + growth-strategist + content-planner + x-writer)
3. [ ] Connect a Reddit account via OAuth (or mock a channel insert in psql):
   ```sql
   INSERT INTO channels (id, user_id, platform, username, ...)
   VALUES (gen_random_uuid(), '<userid>', 'reddit', 'testuser_reddit', ...);
   ```
4. [ ] Trigger the channel-connect callback logic (or wait for the OAuth flow to complete)
5. [ ] Refresh `/team`

**Expected**:
- [ ] A new `reddit-writer` or `community-manager` card appears on the team grid (matching the updated preset for the category + reddit channel)
- [ ] The addition happens **silently** — no approval dialog, no modal, just a new card appears
- [ ] (Optional polish) A toast message: "Reddit Writer joined your team."
- [ ] Existing members are NOT renamed or removed — only additive

**Fail signals**: no new member added, existing members modified, duplicate members, error on callback.

---

## Test 12 — Design polish checks

**Purpose**: verify brand polish from Phase D Day 3.

Visit each team page and verify:

- [ ] `/team` uses `--sf-*` CSS design tokens (inspect with DevTools Elements panel → computed styles)
- [ ] Member cards have per-agent **accent colors** (coordinator = Apple Blue, growth-strategist = green, content-planner = orange; others use hash-derived gradient)
- [ ] **Hover state** on member cards: subtle elevation + shadow lift (200ms ease)
- [ ] **Focus state**: keyboard Tab lands on each card visibly (focus ring or lift)
- [ ] Cost figure uses `tabular-nums` (all digits same width)
- [ ] Activity log message timestamps use `tabular-nums`
- [ ] Page respects **dark mode** if app has one (toggle system dark mode, verify all colors still look intentional)

**Responsive tests** (DevTools → Device Toolbar):
- [ ] 1440px wide: team grid shows 3+ columns
- [ ] 1024px: grid shows 2-3 columns
- [ ] 768px: grid shows 2 columns
- [ ] 375px (mobile): grid shows 1 column, cards full-width, activity log stacks message meta + body vertically
- [ ] No horizontal overflow at any breakpoint

**Fail signals**: generic Tailwind defaults visible, no accent colors, unreadable on mobile, dark mode broken, focus invisible.

---

## Test 13 — Accessibility spot-checks

**Purpose**: verify WCAG AA basics.

1. [ ] Tab through `/team` keyboard-only (no mouse)
- [ ] Focus ring visible on each interactive element
- [ ] Tab order is top-to-bottom, left-to-right
- [ ] Enter on a focused member card opens detail page

2. [ ] On `/team/[memberId]`:
- [ ] The activity log is a semantic `<ol>` with `role="log"` (inspect DOM)
- [ ] `aria-live="polite"` on the log so screen readers announce new messages
- [ ] Send-message-form has `aria-label` including the recipient's name
- [ ] Timestamps use `<time dateTime="...">` elements

3. [ ] Color contrast: open DevTools Lighthouse → run Accessibility audit
- [ ] Score ≥ 90

**Fail signals**: keyboard traps, no focus rings, missing ARIA, contrast violations.

---

## Test 14 — E2E Playwright smoke (optional)

**Purpose**: run the automated E2E spec.

```bash
# Run the UI-only spec (fast, mocked)
pnpm test:e2e e2e/tests/team.spec.ts

# Run the full real-API spec (slow, costs ~$0.50)
RUN_FULL_E2E=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test:e2e e2e/tests/team-full-run.spec.ts
```

- [ ] UI spec passes
- [ ] Full-run spec passes (if you want to burn $0.50)

---

## Summary

| Test # | Feature | Pass / Fail / Skipped |
|---|---|---|
| 1 | /team empty state | |
| 2 | Onboarding Meet-your-team | |
| 3 | Team auto-provisioning | |
| 4 | SSE streaming + activity log | |
| 5 | SSE reconnection | |
| 6 | Direct message + live injection | |
| 7 | Admin non-admin blocked | |
| 8 | Admin list view | |
| 9 | Admin detail view | |
| 10 | Budget auto-pause | |
| 11 | Channel-connect reconciliation | |
| 12 | Design polish | |
| 13 | Accessibility | |
| 14 | E2E Playwright | |

**Acceptance**: at least Tests 1-9 must pass for ship. Tests 10-11 verify advanced flows. Tests 12-14 are polish/optional.

If any Fail: file a bug with the exact test number + step + observed vs expected.

---

## Quick rollback if production regresses

```bash
# Within 48h of deploy:
git reset --hard pre-phase-g-cutover   # or appropriate pre-<phase>-cutover tag
git push --force-with-lease origin dev
# Then redeploy
```

See `docs/phase-c-deferred.md` and section §17 of the spec for the full rollback matrix.
