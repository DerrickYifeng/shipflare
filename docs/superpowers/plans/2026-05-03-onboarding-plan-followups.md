# Onboarding Plan Route — MEDIUM/LOW Follow-ups

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 3 small follow-ups from the post-merge review of `19436f6` — all in `src/app/api/onboarding/plan/route.ts`. One file, one commit, no behavior change.

**Architecture:** Pure code-quality cleanup. No new tests required (existing 13 tests cover the underlying behavior). DRY a duplicated date-parse pair, replace the unreachable race-loss throw with a structured error suitable for the SSE stream, fix one stale comment line ref.

**Tech Stack:** TypeScript, Next.js Route Handler, Vitest.

---

## What's IN scope (3 items)

1. **MEDIUM — DRY `launchDate` / `launchedAt` parsing.** Currently parsed at `route.ts:157-158` (top-level body normalization) AND `route.ts:241-242` (inside the new INSERT block). Same coercion logic, two copies. Hoist into a single resolution that both sites consume.

2. **MEDIUM — race-loss unreachable throw.** `route.ts:273-275` currently does:
   ```ts
   if (!refetched) {
     throw new Error('lost the race but no row was found');
   }
   ```
   Theoretically unreachable per Postgres READ COMMITTED + unique-index visibility semantics, BUT if it ever fires (driver bug, exotic isolation, etc.), it surfaces as a generic 500 with a string the user/operator can't action. Replace with a structured log + a stable error code so we can grep / alert on it.

3. **LOW — stale comment line ref.** `route.ts:224-228` cites `commit/route.ts:175-192` but the actual UPDATE is at line 183. Update the cite.

## What's OUT of scope

- Changing the race semantics (the resolve-or-insert logic stays).
- Adding new tests (existing 13 cover the resolve / reuse / race branches).
- Touching `WriteStrategicPathTool`, agent-run.ts, or the commit route.

---

## Pre-flight context (read once)

- File under modification: `src/app/api/onboarding/plan/route.ts`. Two test files cover it: `__tests__/route.test.ts` (13 tests, full coverage of the resolve/insert/race paths).
- Current dev HEAD: `19436f6`. Latest 3 commits all landed today; this is the cleanup pass.
- Build gate: `pnpm tsc --noEmit --pretty false` exit 0.
- The test surface SHOULD NOT change — these fixes are behavior-preserving. If a test breaks, the fix is wrong, not the test.

---

## Task 1: Three small fixes in `route.ts`

**Files:**
- Modify: `src/app/api/onboarding/plan/route.ts` only.
- Tests: `src/app/api/onboarding/plan/__tests__/route.test.ts` should pass UNCHANGED. If a test fails, you broke behavior — fix the implementation, not the test.

### Task 1 spec

**Part A — DRY `launchDate` / `launchedAt` parsing.**

Current state:
- Lines 157-158 (approximately — verify exact location):
  ```ts
  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  ```
- Lines 241-242 (inside the new INSERT block):
  ```ts
  launchDate: body.launchDate ?? null,
  launchedAt: body.launchedAt ?? null,
  ```

Wait — the first uses `new Date(...)` (Date object), the second uses the raw string. Confirm by reading both sites carefully. If they ARE producing different shapes (Date vs string), the products column type dictates which is correct, and the duplication isn't actually duplication — it's a bug-preventing copy. In that case:

- Determine the products column type for `launchDate`/`launchedAt` from `src/lib/db/schema/products.ts`.
- The INSERT call must produce values matching that column type.
- The UPDATE/snapshot site at line 157-158 uses a Date — confirm Drizzle's INSERT can accept either, OR align both to Date.

If both sites produce the same type, hoist:
```ts
// At the top of the request handler, after body validation:
const launchDate = body.launchDate ? new Date(body.launchDate) : null;
const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
```
Then in the INSERT block:
```ts
launchDate,
launchedAt,
```

**Implementer judgment**: pick whichever shape Drizzle expects. If the field is `timestamp` in the products schema, prefer `Date`. If `body.launchDate` is already a string and Drizzle accepts strings for timestamp columns, the `?? null` form is fine — but use ONE form in BOTH places for consistency.

**Part B — Replace unreachable throw with structured logging.**

Current state (`route.ts:273-275`):
```ts
if (!refetched) {
  throw new Error('lost the race but no row was found');
}
```

Replace with:
```ts
if (!refetched) {
  // Theoretically unreachable: PG READ COMMITTED + unique index means
  // the racing tx's row is committed-and-visible by the time
  // onConflictDoNothing returns []. If we ever hit this, it indicates
  // a driver-level invariant break (or REPEATABLE READ in the connection
  // pool). Log with enough context to triage, then throw a stable code.
  log.error(
    `onboarding/plan: race-loss re-select returned no row for user=${userId} traceId=${traceId} — products_user_uq invariant broken`,
  );
  throw new Error('PRODUCTS_RACE_REFETCH_MISS');
}
```

The bare `throw new Error('PRODUCTS_RACE_REFETCH_MISS')` is a stable code an alert can grep for. The structured log carries `userId` + `traceId` so an oncall can find the original request. Keep it loud — don't swallow.

If the route's existing logger isn't named `log`, use whatever it actually imports as. Confirm by reading the imports at the top of `route.ts`.

**Part C — Fix stale comment line ref.**

Current state (`route.ts:224-228` approximately):
```ts
// ... commit/route.ts:175-192 ...
```

Find the exact citation; verify the actual line number of the UPDATE in `commit/route.ts` (the reviewer said line 183). Update the cite to a small line range that brackets the actual UPDATE block — e.g. `commit/route.ts:175-213` (which covers BOTH the UPDATE arm and the INSERT arm of the upsert). Citing the whole block is more rot-resistant than a single line.

### Task 1 steps

- [ ] **Step 1: Pre-implementation reads**

  - Read `src/app/api/onboarding/plan/route.ts` lines 150-280 to see ALL three sites in context.
  - Read `src/lib/db/schema/products.ts` for the `launchDate` / `launchedAt` column types — Date vs string matters for Part A.
  - Read `src/app/api/onboarding/commit/route.ts` lines 170-215 to find the EXACT line where the UPDATE happens (Part C).
  - Confirm the route's logger import name.

- [ ] **Step 2: Apply Part A (DRY).**

  Hoist `launchDate` / `launchedAt` parsing to a single site near the top of the handler. Reference both names in the INSERT block. Use the form Drizzle expects (Date for `timestamp` columns; string only if the column is `text`).

- [ ] **Step 3: Apply Part B (structured race-loss).**

  Replace the bare throw with a `log.error(...)` + `throw new Error('PRODUCTS_RACE_REFETCH_MISS')`. Include `userId` + `traceId` in the log message.

- [ ] **Step 4: Apply Part C (comment cite).**

  Update the comment line ref to bracket the full upsert block (e.g. `commit/route.ts:175-213`).

- [ ] **Step 5: Run vitest — same suite, same passing state.**

  `pnpm vitest run src/app/api/onboarding/plan/__tests__/route.test.ts`
  Expected: 13/13 pass UNCHANGED. If a test fails, you broke behavior. Fix the implementation, not the test.

- [ ] **Step 6: Wider sweep**

  `pnpm vitest run src/app/api/onboarding/`
  Expected: all green.

- [ ] **Step 7: Type-check the build gate**

  `pnpm tsc --noEmit --pretty false`
  Expected: exit 0.

- [ ] **Step 8: Commit ON THE WORKTREE BRANCH**

  ⚠️ **CRITICAL — DO NOT COMMIT ON `dev`.** This commit MUST land on the worktree branch (`worktree-agent-<your-id>`). Run `git branch --show-current` BEFORE the commit and confirm it starts with `worktree-agent-`. If you're on `dev`, run `git checkout -b worktree-agent-<id>` FIRST.

  ```bash
  git add src/app/api/onboarding/plan/route.ts
  git commit -m "$(cat <<'EOF'
  refactor(onboarding/plan): DRY date parsing + structured race-loss + comment cite

  Three small follow-ups from the 19436f6 post-merge review:
  - Hoist launchDate/launchedAt parsing to a single site so the new
    INSERT block and the existing top-level normalization stay in sync.
  - Replace bare 'lost the race but no row was found' throw with a
    structured log.error + stable error code (PRODUCTS_RACE_REFETCH_MISS)
    so an oncall can grep / alert on it. Path remains theoretically
    unreachable per PG READ COMMITTED visibility semantics.
  - Update commit/route.ts cite to bracket the full upsert block.

  No behavior change. Existing 13 tests pass unchanged.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

  After the commit, run `git log --oneline -1` and verify the commit is on a `worktree-agent-*` branch, NOT on `dev`. Report the worktree branch name back so the controller can ff-merge.

---

## Self-review checklist

- [x] Single-file change with no behavior modification.
- [x] No new tests; existing 13 tests should pass unchanged.
- [x] Implementer judgment call documented for Part A's Date-vs-string choice.
- [x] Race-loss path stays loud (logged + throws), not silently swallowed.
- [x] Worktree-branch commit constraint stated explicitly to avoid the previous commit's process anomaly.
