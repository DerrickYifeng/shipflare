# Live-Smoke Handoff — Resume After Returning

**Date:** 2026-05-03 (left autonomous slot mid-session)
**Status:** 3 live-smoke specs ready to run; storageState capture is on you (OAuth requires your hands)

---

## What got done while you were away

I shipped Phase 0 (the live-smoke Playwright project + npm scripts) earlier in the session.
Then in this autonomous slot I added the **3 highest-value spec files** that target today's three bug classes:

| Spec | Catches |
|---|---|
| `e2e/tests/onboarding-fresh.live-smoke.ts` | Phase 0.5 — `write_strategic_path: product null not found` (today's morning bug, fixed `19436f6`) |
| `e2e/tests/team-chat.live-smoke.ts` | Phase 1 — lead's `{productName}` placeholders + `Missing dependency: userId` (fixed `8da3146` + `018f885`) |
| `e2e/tests/team-delegation.live-smoke.ts` | Phase 2 — `team_tasks.run_id` FK violation on Task delegation (fixed `5ca8887`) |

All 3 specs:
- Parse cleanly (`pnpm test:e2e:live:ci --list` shows 3 tests across 3 files)
- Skip gracefully when `.auth/founder.json` (or `.auth/founder-fresh.json` for Phase 0.5) is missing → no breakage to `pnpm test:e2e`
- tsc + lint clean

What I did **NOT** do: actually run them. I can't drive Playwright against your real account because GitHub OAuth needs your consent at the screen. Deleting your account autonomously would have left you signed-out with no recovery path.

---

## What you do next (~10 min)

### Option A: Run all 3 phases (most thorough, requires the destructive deletion)

```bash
# 1. Delete your account (DESTRUCTIVE — clean dev DB only). Open psql or your DB UI:
DELETE FROM users WHERE email = 'cdhyfpp@gmail.com';
# Cascades through: team, agent_runs, drafts, channels, products, strategic_paths, plan_items, etc.

# 2. Sign in fresh: open http://localhost:3000 in your real browser.
#    Click GitHub sign-in. Authorize. You'll land on /onboarding/source.

# 3. CAPTURE STORAGESTATE — keep that signed-in tab open and capture cookies separately:
mkdir -p .auth
pnpm playwright codegen --save-storage=.auth/founder-fresh.json http://localhost:3000
# In the Codegen window: just verify you're signed in (e.g. browse to /onboarding/source).
# Close the Codegen window. .auth/founder-fresh.json now has the freshly-signed-in session.

# 4. Run Phase 0.5 (drives onboarding stages 1–4 against your real LLM):
pnpm test:e2e:live -- e2e/tests/onboarding-fresh.live-smoke.ts
# A real Chromium opens. You watch it. ~2-3 min total. ~$0.20 LLM.
# Pass = no `product null not found`, no `{productName}` placeholders, lands on /team or /today.

# 5. NOW capture the post-onboarding storageState for Phases 1 + 2:
pnpm playwright codegen --save-storage=.auth/founder.json http://localhost:3000
# Confirm you're on /team. Close.

# 6. Run Phase 1 + 2:
pnpm test:e2e:live -- e2e/tests/team-chat.live-smoke.ts
pnpm test:e2e:live -- e2e/tests/team-delegation.live-smoke.ts
# Each opens a Chromium, drives a real chat with the lead. ~$0.30 LLM total.
```

### Option B: Skip Phase 0.5, just smoke the existing onboarded state (faster, ~5 min)

```bash
# 1. CAPTURE STORAGESTATE from your already-signed-in session:
mkdir -p .auth
pnpm playwright codegen --save-storage=.auth/founder.json http://localhost:3000
# In the Codegen window: confirm you're on /team or /today. Close.

# 2. Run Phase 1 + 2:
pnpm test:e2e:live -- e2e/tests/team-chat.live-smoke.ts
pnpm test:e2e:live -- e2e/tests/team-delegation.live-smoke.ts
# ~$0.30 LLM total. ~5 min.
```

### Option C: Just see if the infrastructure works (smallest commitment, ~1 min)

```bash
# Capture storageState only — don't run any spec yet.
mkdir -p .auth
pnpm playwright codegen --save-storage=.auth/founder.json http://localhost:3000
# Confirm session works. Close. Done. You can run specs later when you have time.
```

---

## What to look for during a live-smoke run

Each spec opens a real Chromium window (`--headed` is the default for `pnpm test:e2e:live`). You watch it drive your real account. Specifically:

**Phase 0.5 (onboarding-fresh):**
- Stage 1 → website URL field gets typed → Extract clicked → extracted info renders
- Stage 2 → Continue clicked
- Stage 3 → SSE streams the strategic path. The browser shows "milestones / content pillars / thesis arc" sections appearing.
- **CRITICAL** — no error toast like "planner_timeout" or "product null not found"
- Stage 4 → Commit clicked → redirects to /team or /today
- Spec passes within ~2-3 min

**Phase 1 (team-chat):**
- Lands on /team
- Composer types `[smoke] What's my current strategic phase...`
- Within 60s, an activity card with `query_strategic_path` (or similar) appears
- Within ~30s after that, the lead's response text appears
- **CRITICAL** — response mentions YOUR real product name (not literal `{productName}`)
- Spec passes within ~90s

**Phase 2 (team-delegation):**
- Lands on /team
- Composer types `[smoke] Please draft 2 short X posts...`
- Within 90s, a `Task` activity card appears
- A teammate row appears in the roster sidebar
- Within 3min, a "completed" / "drafted" status appears
- **CRITICAL** — no `Tool Task failed` / `Failed query` errors in the worker log
- Spec passes within ~3min

If a spec fails: failing screenshot lands in `test-results/`. Inspect there before re-running.

---

## Cleanup after smoke

```sql
-- Drafts created by Phase 2 (tagged with [smoke] in body):
DELETE FROM drafts WHERE body ILIKE '%[smoke]%' AND created_at > now() - interval '1 hour';
```

Don't delete `team_messages` or `agent_runs` rows — they're useful as historical signal in `/admin/team-runs`.

---

## Pending live-smoke phases not yet shipped

- **Phase 3** — today/drafts page (approve a draft, verify state transition)
- **Phase 4** — plan page (view + edit)
- **Phase 5** — admin/team-runs (per-request observability — drill into a request from Phase 1 or 2)
- **Phase 6** — negative paths (cancel teammate, drawer stability, refresh)
- **Phase 7** — settings + account

If you want any of these added, ping me when you return.

---

## If something breaks during a smoke

The spec output + screenshot in `test-results/` will tell you what. Common patterns:

| Symptom | Likely cause |
|---|---|
| "page.locator('something').isVisible() timed out" | Selector is too specific or UI label changed. Loosen the regex in the spec. |
| "expect(allText).not.toMatch(/.../)" failed with the matched string visible | A REAL regression — that bug class is back. Triage. |
| Spec hangs > 5 min | LLM is slow OR the lead got stuck in a loop. Tail `bun run dev` worker log to diagnose. |
| "ECONNREFUSED localhost:3000" | Dev server not running. Start it: `bun run dev`. |
