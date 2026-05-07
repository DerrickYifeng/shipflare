# Fix `react-hooks/set-state-in-effect` Lint Errors (3 sites)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 pre-existing `react-hooks/set-state-in-effect` lint errors in two team-UI files. Today these block `git push` to remote (pre-push hook runs `pnpm lint && pnpm typecheck && pnpm test`). All three are real cascading-render risks; React's modern guidance recommends specific replacements that don't use a reactive effect.

**Architecture:** One task, one commit, two files. No behavior change visible to the user. The fixes use React's "deriving state from props" pattern (prev-ref comparison + `setState` during render) and pushing cleanup logic to the source of state change instead of a reactive effect.

**Tech Stack:** React 19, Next.js 15, TypeScript, ESLint with `react-hooks/set-state-in-effect`, Playwright for the smoke test.

---

## The 3 lint errors

```
src/app/(app)/team/_components/teammate-roster.tsx
  434:5   error    Calling setState synchronously within an effect can trigger cascading renders
  452:18  error    Calling setState synchronously within an effect can trigger cascading renders

src/app/(app)/team/_components/teammate-transcript-drawer.tsx
  221:7  error  Calling setState synchronously within an effect can trigger cascading renders
```

---

## Pre-flight context (read once)

- **Site 1 — `teammate-roster.tsx:434`**: re-seeds local `state` from `initialLead` / `initialTeammates` props when they change. Pattern: parent re-fetches → new props arrive → effect runs → `setState({lead: initialLead, teammates: [...initialTeammates]})`. Cascading-render risk: setting state synchronously during effect commits triggers another render.

- **Site 2 — `teammate-roster.tsx:452`**: cleanup of `cancellingIds` set when a teammate row disappears (after SSE-driven `applyStatusChange` removes it). Pattern: effect reads `state.teammates` + `cancellingIds`, computes a smaller set, calls `setCancellingIds(next)`. Cascading risk: state change fires the effect which fires another setState.

- **Site 3 — `teammate-transcript-drawer.tsx:221`**: reset on prop change. Pattern: when `agentId` becomes null/undefined, reset `state` to `INITIAL_STATE` so re-opening doesn't flash stale messages. Same pattern class as Site 1.

- **React's modern guidance** ("You Might Not Need an Effect" docs): for "reset state when prop changes" patterns, prefer ref-comparison + `setState` during render. React batches that into the same render cycle (no cascading) and the lint rule recognizes it. For cleanup of derived state, push the cleanup to the source of state change (the reducer / SSE handler) instead of a reactive effect.

- **Build gate**: `pnpm lint` exit 0 (this is the FAILING gate today). Plus `pnpm tsc --noEmit --pretty false` exit 0 + `pnpm vitest run` green.

- **Worktree branch reminder**: commit on `worktree-agent-<id>`, NOT on `dev`. Run `git branch --show-current` before commit. (Recurring issue; saved as feedback memory.)

---

## Task 1: Apply 3 fixes + add Playwright smoke

### Site 1 fix — `teammate-roster.tsx:431-435`

Replace the `useEffect` with the **prev-ref comparison + setState-during-render** pattern. React 19's lint rule recognizes this as safe.

**Before:**
```ts
// Re-seed when the parent re-fetches (e.g. after a navigation): the
// initial props become the new authoritative snapshot.
useEffect(() => {
  setState({ lead: initialLead, teammates: [...initialTeammates] });
}, [initialLead, initialTeammates]);
```

**After:**
```ts
// Re-seed when the parent re-fetches (e.g. after a navigation): the
// initial props become the new authoritative snapshot. Done at render
// via ref-comparison (sanctioned by React's "you might not need an
// effect" guidance) so we don't trigger a cascading render — React
// batches the prop-driven setState into the SAME render cycle.
const prevInitialLeadRef = useRef(initialLead);
const prevInitialTeammatesRef = useRef(initialTeammates);
if (
  prevInitialLeadRef.current !== initialLead ||
  prevInitialTeammatesRef.current !== initialTeammates
) {
  prevInitialLeadRef.current = initialLead;
  prevInitialTeammatesRef.current = initialTeammates;
  setState({ lead: initialLead, teammates: [...initialTeammates] });
}
```

(Add `useRef` to the React import at the top of the file if it's not already imported.)

### Site 2 fix — `teammate-roster.tsx:437-453`

The cleanup effect can be eliminated by sourcing the cleanup from `applyStatusChange` (the reducer that removes teammate rows on terminal-status SSE events). When `applyStatusChange` removes a teammate, ALSO emit a "drop this id from cancellingIds" signal.

**Read `applyStatusChange` first** — find its definition (search the file). It's likely in the same file or imported. Trace it.

**Approach:** since `applyStatusChange` is a pure reducer over `state` (the `{lead, teammates}` shape) and does NOT have access to `cancellingIds`, either:

- **Option A (simpler):** drop the cleanup effect entirely and accept that `cancellingIds` may carry stale ids. Render-time use of `cancellingIds` should already filter to live ids implicitly when looking up by agentId — verify with grep. If a stale id never gets read for any rendered row, it's a small bounded leak per session (each cancel POST adds one) — acceptable for an admin UI in a long-lived browser tab.

- **Option B (cleaner):** keep `cancellingIds` cleanup but move it INSIDE the SSE handler. Where `setState((prev) => applyStatusChange(prev, ev))` is called (around line 460), also call `setCancellingIds((prev) => { if (ev.terminal && prev.has(ev.agentId)) { const next = new Set(prev); next.delete(ev.agentId); return next; } return prev; })` (with logic adapted to the actual `ev` shape — verify by reading `readStatusChange`).

**Implementer judgment**: pick A or B. A is fewer LOC and preserves the existing render-time filter behavior (verify it exists). B is more correct but couples the cleanup to the SSE handler. If unsure, use A and add a comment explaining the bounded-leak semantics.

Either way, **delete the entire `useEffect` block at lines 437-453** so the lint error goes away.

### Site 3 fix — `teammate-transcript-drawer.tsx:217-223`

Same pattern as Site 1: prev-ref comparison + setState during render for the agentId reset case.

**Before:**
```ts
useEffect(() => {
  if (!agentId) {
    // Reset so re-opening the drawer doesn't flash the previous
    // teammate's messages while the new fetch is in flight.
    setState(INITIAL_STATE);
    return;
  }
  const controller = new AbortController();
  setState({ status: 'loading', messages: [], error: null });
  fetch(...)
    ...
}, [agentId]);
```

**After:**
```ts
// Reset on agentId change BEFORE the fetch effect runs, via the
// ref-compare-during-render pattern. This avoids the cascading-render
// risk of setState-in-effect AND ensures the drawer never flashes the
// previous teammate's messages while a new fetch is in flight.
const prevAgentIdRef = useRef(agentId);
if (prevAgentIdRef.current !== agentId) {
  prevAgentIdRef.current = agentId;
  setState(agentId ? { status: 'loading', messages: [], error: null } : INITIAL_STATE);
}

useEffect(() => {
  if (!agentId) return;
  const controller = new AbortController();
  // setState({ status: 'loading' }) was hoisted to the ref-compare
  // block above so the loading flash happens synchronously with the
  // agentId change, not on the next render.
  fetch(`/api/team/agent/${encodeURIComponent(agentId)}/transcript`, {
    signal: controller.signal,
  })
    .then(async (res) => {
      ...
    });
  return () => controller.abort();
}, [agentId]);
```

(Add `useRef` to the React import if needed.)

### Playwright smoke test — `e2e/tests/team-roster-state-stability.spec.ts` (new file)

Per the new "every plan needs a real-browser smoke" feedback rule: add a focused Playwright spec that exercises the patterns most likely to regress.

```ts
import { test, expect } from '@playwright/test';
// Use whatever auth helper the project's existing team specs use.
// Look at e2e/tests/team.spec.ts for the established pattern.

test.describe('Team roster + transcript drawer — state-stability fixes', () => {
  test('roster re-seed on parent re-fetch does not flash empty', async ({ page }) => {
    // Sign in. Visit /team. Trigger a parent re-fetch (e.g. by
    // clicking a refresh button or navigating away + back). Assert
    // the roster is populated continuously — never goes through an
    // empty state during the prop transition.
    // If a refresh button doesn't exist, navigate to /today + back
    // to /team and verify the roster's last-known state stays
    // visible across the navigation.
  });

  test('transcript drawer reset on close does not flash previous messages', async ({ page }) => {
    // Sign in. Open the team page. Open the transcript drawer for
    // teammate A — verify some message renders. Close it. Open it
    // again for teammate B (or null) — assert that within 100ms we
    // do NOT see teammate A's messages still rendered (which would
    // indicate the reset effect didn't fire).
    // If only one teammate exists in the test seed, assert that
    // closing the drawer + reopening for a NULL agentId resets state.
  });
});
```

**Implementer judgment:** if writing a non-trivial Playwright test for the drawer turns out to require setting up complex SSE fixtures, downgrade to a simpler smoke that just verifies the page renders without a hydration warning. The minimum bar is: lint passes, lint passes after a `pnpm dev` page-load (since the dev server runs the React strict-mode-style double-effect dance and would surface hydration warnings if the new code is wrong).

If you can't make the Playwright test load real data, fall back to a vitest snapshot/render test using `@testing-library/react` that asserts the state-machine transitions correctly for the patched components.

---

## Task 1 steps

- [ ] **Step 1: Pre-implementation reads**
  - Read `teammate-roster.tsx` lines 380-470 to see Site 1 + Site 2 + the surrounding `applyStatusChange` and `useTeamEvents` integration.
  - Read `teammate-transcript-drawer.tsx` lines 200-260 to see Site 3 + the fetch effect that follows.
  - Find `applyStatusChange` definition (likely same file or `_components/conversation-reducer.ts`-style sibling). Trace what `ev.terminal` looks like.
  - Confirm `useRef` is or isn't already imported in each file.

- [ ] **Step 2: Apply Site 1 fix** in `teammate-roster.tsx`. Run `pnpm lint` to confirm Site 1 error is gone.

- [ ] **Step 3: Apply Site 2 fix** (Option A or B per your judgment). Document the choice in the comment block. Run `pnpm lint` again — Site 2 error gone.

- [ ] **Step 4: Apply Site 3 fix** in `teammate-transcript-drawer.tsx`. Run `pnpm lint` — Site 3 error gone, total lint errors should now be 0.

- [ ] **Step 5: Run the build gates**
  - `pnpm lint` → 0 errors
  - `pnpm tsc --noEmit --pretty false` → exit 0
  - `pnpm vitest run` → 1158/1158 unchanged

- [ ] **Step 6: Add the Playwright smoke** at `e2e/tests/team-roster-state-stability.spec.ts`. Model on `e2e/tests/team.spec.ts` for auth + setup. Run `pnpm test:e2e -- e2e/tests/team-roster-state-stability.spec.ts` and confirm green (or skip-gracefully if seed data isn't available locally).

- [ ] **Step 7: Verify branch + commit**

  `git branch --show-current` must start with `worktree-agent-`.

  ```bash
  git add src/app/\(app\)/team/_components/teammate-roster.tsx \
          src/app/\(app\)/team/_components/teammate-transcript-drawer.tsx \
          e2e/tests/team-roster-state-stability.spec.ts
  git commit -m "$(cat <<'EOF'
  fix(team UI): close 3 react-hooks/set-state-in-effect lint errors

  Two patterns were flagged as cascading-render risks:
  - "reset state on props change" via setState in useEffect (sites 1
    and 3) — replaced with React's sanctioned ref-compare + setState
    during render pattern.
  - "cleanup derived state on dependent state change" via setState in
    useEffect (site 2) — moved cleanup to the SSE handler / dropped
    the reactive effect (implementer to specify A/B in this commit
    message).

  Unblocks `git push` to remote: pre-push hook runs `pnpm lint`, which
  was failing on these 3 errors today (pre-existing from the UI-B work
  on 2026-05-02).

  Smoke:
  - e2e/tests/team-roster-state-stability.spec.ts (run: pnpm test:e2e
    -- e2e/tests/team-roster-state-stability.spec.ts)
  - Verifies roster doesn't flash empty during parent re-fetch and
    drawer doesn't flash previous teammate's messages on close.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

  After commit: `git log --oneline -1` to verify on worktree branch.

- [ ] **Step 8: Report**

  DONE / DONE_WITH_CONCERNS / BLOCKED + worktree branch name + commit sha.

---

## Real-browser smoke test (controller-runnable)

After the implementer reports DONE and reviewers approve, the controller should run this manually before ff-merge:

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev &
# Visit http://localhost:3000/team in browser, log in if needed.
# Confirm:
#   - team page renders with the roster populated
#   - clicking a teammate opens the transcript drawer with correct messages
#   - closing the drawer + opening it again for a different teammate doesn't flash stale messages
#   - no console.error about React state-update warnings
# Then kill the dev server.
```

If the manual smoke surfaces a regression, fix-up commit on the same worktree branch.

---

## Self-review checklist

- [x] Each lint error has a dedicated fix step with concrete before/after code.
- [x] React's modern guidance referenced for the chosen patterns.
- [x] Implementer-judgment escape hatch for Site 2 (Option A vs B).
- [x] Playwright smoke section added per the new feedback rule.
- [x] Worktree-branch commit reminder restated.
- [x] Build gates explicit (`lint`, `tsc`, `vitest`).
- [x] Backwards-compat: no behavior change visible to user; only React's internal commit timing changes.
