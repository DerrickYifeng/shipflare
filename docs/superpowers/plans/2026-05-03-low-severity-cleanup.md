# Low-Severity Cleanup Bundle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 4 LOW-severity findings flagged across today's review cycles. Single task, single commit. Each item is small and isolated.

**Architecture:** One commit on a fresh worktree. Same two-stage opus review. Skip the gap audit (no user-visible symptom to verify — these are stylistic / test polish).

**Tech Stack:** TypeScript, Vitest, `pnpm tsc --noEmit` as the build gate.

**Out of scope:** `createTeamPlatformDeps` memoization (needs invalidation-strategy brainstorm before implementation; deferred per the user's explicit decision).

---

## What's IN scope (4 items)

1. **Test args[7] positional → named/object signature.** Several tests in `src/workers/processors/__tests__/agent-run.test.ts` reach into `runAgentMock.mock.calls[i][7]` to grab the `onEvent` argument. If `runAgent`'s signature ever shifts a parameter, these tests silently no-op. Refactor by reading the runAgent type definition and switching to a sturdier accessor — either a small named helper that finds onEvent by signature shape, or refactor `runAgentMock` to record calls with named keys.

2. **Positional destructure coupling** in the new `Promise.all` bundle in `src/lib/team/system-prompt-context.ts`. Currently `[productRows, pathRows, channelRows, planItemRows, userRows, memberRows] = await Promise.all([...])`. Adding a 7th query in the middle silently shifts consumers. Refactor to object-destructure pattern: `const { productRows, pathRows, ... } = await runQueries({...})` where `runQueries` builds the object, awaits each entry, and returns a typed bag.

3. **Default vocabulary inconsistency.** Current loader produces three different conventions for "no value":
   - Bare: `'unknown'`, `'none yet'`
   - Parenthesized: `'(none)'`, `'(none yet — team_members table is empty)'`
   - Descriptive: `'your product'`, `'(product not configured)'`

   Standardize on three semantic roles:
   - `'(none yet)'` — "field hasn't been populated yet" (channels, strategicPathId, teamRoster, productDescription)
   - `'(none)'` — "explicit zero count" (statusBreakdown — distinct because it means "we counted, found zero")
   - `'unknown'` — state enums (productState, currentPhase — preserved because semantic; the AGENT.md author treats these like enum values)
   - `'your product'` — friendly fallback name (productName)

   Concretely: rename `'none yet'` → `'(none yet)'` (for `strategicPathId` and `channels`); replace `'(none yet — team_members table is empty)'` → `'(none yet)'` for `teamRoster`; replace `'(product not configured)'` → `'(none yet)'` for `productDescription`. Keep `'(none)'`, `'unknown'`, `'your product'` unchanged.

4. **4 dead `teamSelectChain.limit.mockResolvedValueOnce` stubs** in `src/workers/processors/__tests__/agent-run.test.ts`. After Task 2 of the prior plan (`fd9ee1a`), `loadSystemPromptContext` is mocked at the module boundary, so several tests still call `teamSelectChain.limit.mockResolvedValueOnce(...)` whose return is no longer consumed. Remove these dead stubs so future test readers don't wonder why the override exists.

---

## Pre-flight context (read once)

- Today's prior commits on dev (the 8-commit arc): `0750a35`...`d23cefc`. Latest dev HEAD is `d23cefc`.
- The plan is a SINGLE task (Task 1) with 4 sub-parts. All commit together.
- The dead test stubs were specifically called out by the Task 2 reviewer of `fd9ee1a` — search `agent-run.test.ts` for the four `teamSelectChain.limit.mockResolvedValueOnce` calls; they're easy to grep.
- Vocabulary changes touch tests too — every test that asserts `statusBreakdown === ''`, `teamRoster === ''`, `'none yet'`, `'(product not configured)'`, etc. needs updating in lockstep.
- For item 1 (test sturdiness): `runAgent`'s signature lives in `src/core/query-loop.ts` (or wherever runAgent is defined). The `onEvent` callback is at a specific positional index — find it once and document.
- Build gate: `pnpm tsc --noEmit --pretty false` exit 0.

---

## Task 1: Bundle the 4 LOW cleanups

**Files:**
- Modify: `src/lib/team/system-prompt-context.ts` (items 2, 3).
- Modify: `src/lib/team/__tests__/system-prompt-context.test.ts` (item 3 test updates).
- Modify: `src/workers/processors/__tests__/agent-run.test.ts` (items 1, 4; possibly 3 too).
- Modify: `src/workers/processors/agent-run.ts` ONLY if a vocabulary change in the loader propagates an assertion that was previously hardcoded in agent-run (unlikely — verify with grep).

### Task 1 spec

**Part A — sturdier onEvent accessor in tests.**

Find every `runAgentMock.mock.calls[i][7]` (or `lastCall?.[7]`, etc.) reference in `agent-run.test.ts`. The `runAgent` signature (from `src/core/query-loop.ts`) is:
```ts
export async function runAgent<TResult>(
  config: AgentConfig,
  initialPrompt: string,
  toolContext: ToolContext,
  outputSchema?: ZodType,
  onProgress?: ProgressCallback,
  prebuilt?: ...,
  onIdleReset?: ...,
  onEvent?: (event: StreamEvent) => void | Promise<void>,
  injectMessages?: ...,
  priorMessages?: ...,
): Promise<AgentResult<TResult>>;
```

`onEvent` is positional arg index 7 (zero-based). Refactor strategy:

**Option A (lightest)**: define a small helper at the top of `agent-run.test.ts`:
```ts
// onEvent is the 8th positional arg of runAgent (index 7). Pinning the
// index here so a single signature shift surfaces as a single test failure
// instead of N silent no-ops scattered across the file.
const RUN_AGENT_ON_EVENT_ARG_INDEX = 7;

function getOnEventFromCall(call: Parameters<typeof runAgent>): typeof call[7] {
  return call[RUN_AGENT_ON_EVENT_ARG_INDEX];
}
```

Then replace `runAgentMock.mock.calls[i][7]` → `getOnEventFromCall(runAgentMock.mock.calls[i])`.

**Option B (sturdier)**: wrap `runAgentMock` to record by parameter name:
```ts
const runAgentMock = vi.fn(async (
  config, prompt, ctx, outputSchema, onProgress, prebuilt, onIdleReset, onEvent, injectMessages, priorMessages
) => {
  recordedCalls.push({ config, prompt, ctx, outputSchema, onProgress, prebuilt, onIdleReset, onEvent, injectMessages, priorMessages });
  return makeFakeRunResult();
});
```

**Implementer judgment** — Option A is a one-paragraph change, Option B is a larger refactor. Pick the minimum-impact option that closes the regression risk. If the file already has a record-by-name pattern elsewhere, follow it.

**Part B — object-destructure for the `Promise.all` bundle.**

Current (`system-prompt-context.ts:198+`):
```ts
const [productRows, pathRows, channelRows, planItemRows, userRows, memberRows] = await Promise.all([
  productId !== null ? db.select(...).from(products).where(...) : Promise.resolve([]),
  db.select(...).from(strategicPaths).where(...).orderBy(...).limit(1),
  db.selectDistinct(...).from(channelsTable).where(...),
  // ...
]);
```

Refactor to:
```ts
const queries = {
  productRows: productId !== null ? db.select(...).from(products).where(...) : Promise.resolve([]),
  pathRows: db.select(...).from(strategicPaths).where(...).orderBy(...).limit(1),
  channelRows: db.selectDistinct(...).from(channelsTable).where(...),
  planItemRows: db.select(...).from(planItems).where(...).groupBy(...),
  userRows: db.select(...).from(users).where(...).limit(1),
  memberRows: db.select(...).from(teamMembers).where(...),
};

const keys = Object.keys(queries) as Array<keyof typeof queries>;
const values = await Promise.all(keys.map((k) => queries[k]));
const results = Object.fromEntries(keys.map((k, i) => [k, values[i]])) as {
  [K in keyof typeof queries]: Awaited<typeof queries[K]>;
};

const { productRows, pathRows, channelRows, planItemRows, userRows, memberRows } = results;
```

**Implementer judgment** — if a simpler `Object.fromEntries` + parallel `Promise.all` form reads cleaner with TypeScript's inference, pick that. The point is: adding a 7th query in the middle should be a one-line add to `queries`, not a coordinated update of two arrays.

**Part C — default vocabulary standardization.**

In `system-prompt-context.ts`, apply these literal-string changes:
- `'none yet'` → `'(none yet)'` for `strategicPathId` and `channels`
- `'(none yet — team_members table is empty)'` → `'(none yet)'` for `teamRoster`
- `'(product not configured)'` → `'(none yet)'` for `productDescription`

Keep unchanged:
- `'(none)'` for `statusBreakdown` (distinct semantic: zero count)
- `'unknown'` for `productState`, `currentPhase` (state enum)
- `'your product'` for `productName` (friendly fallback)

Update test assertions in lockstep. Specifically:
- `system-prompt-context.test.ts:'sane defaults on empty DB'` — assert each default with the new strings.
- Search for any other test (or production code path) that asserts the OLD strings — update them.

**Part D — remove dead `teamSelectChain.limit.mockResolvedValueOnce` stubs.**

Per the Task 2 code reviewer's report, four tests at lines 1970, 2053, 2143, 2233 still call `teamSelectChain.limit.mockResolvedValueOnce(...)` after Task 2 made these dead. Find each call site, verify the override is unused (production code in those test paths now goes through the module-mocked `loadSystemPromptContextMock` instead), and delete the dead lines. Keep the actual test assertions intact.

If `teamSelectChain` itself becomes entirely unreferenced after the four dead stubs are removed, also remove its declaration + the `beforeEach` reset for it (treat as part of the same cleanup — don't leave dead infrastructure).

### Task 1 steps

- [ ] **Step 1: Pre-implementation grep + verify**

  Run these to map the exact change surface:
  - `grep -n "\[7\]" src/workers/processors/__tests__/agent-run.test.ts | head` — find all positional `[7]` accesses for Part A.
  - `grep -n "teamSelectChain" src/workers/processors/__tests__/agent-run.test.ts | head -30` — count current references.
  - `grep -n "'none yet'\|'(product not configured)'\|'(none yet — team_members table is empty)'" src/lib/team src/workers` — find every literal that needs updating.
  - `grep -n "Promise.all" src/lib/team/system-prompt-context.ts` — find the bundle for Part B.

  Document findings in your scratch notes before writing tests.

- [ ] **Step 2: Update test assertions to expect the new vocabulary**

  In `system-prompt-context.test.ts`, update:
  - `'sane defaults on empty DB'` test — assert `productDescription === '(none yet)'`, `strategicPathId === '(none yet)'`, `channels === '(none yet)'`, `teamRoster === '(none yet)'`. Keep `productState === 'unknown'`, `currentPhase === 'unknown'`, `statusBreakdown === '(none)'`, `productName === 'your product'`.
  - Any other tests with these literals — update.

  In `agent-run.test.ts`: probably no changes needed (the loader is module-mocked) — but grep to confirm.

- [ ] **Step 3: Run vitest to verify the assertion-only changes fail**

  `pnpm vitest run src/lib/team/__tests__/system-prompt-context.test.ts`
  Expected: tests fail (production code still emits old strings).

- [ ] **Step 4: Apply Part C — vocabulary standardization in `system-prompt-context.ts`.**

  Replace the four literal strings as specified. Run vitest again — tests should now pass.

- [ ] **Step 5: Apply Part B — object-destructure for Promise.all.**

  Refactor the bundle. Run vitest — same tests, same passing state. The point is: behavior identical, just structurally clearer.

- [ ] **Step 6: Apply Part A — onEvent accessor refactor in `agent-run.test.ts`.**

  Pick Option A (helper) or Option B (named-param mock) — implementer judgment. Replace all `[7]` accesses with the chosen pattern. Run vitest.

- [ ] **Step 7: Apply Part D — delete dead `teamSelectChain` stubs.**

  Remove the four `mockResolvedValueOnce` calls. If `teamSelectChain` is now entirely unreferenced, remove its declaration + reset.

- [ ] **Step 8: Final test sweep**

  `pnpm vitest run` (full suite — these changes are stylistic enough that the wider sweep should be quick and catches any cross-cutting regressions).

  Expected: 1133 tests still pass (or 1133 +/- minor adjustment from your test refactors). No regressions.

- [ ] **Step 9: Type-check the build gate**

  `pnpm tsc --noEmit --pretty false` exit 0.

- [ ] **Step 10: Commit**

  ```bash
  git add src/lib/team/system-prompt-context.ts \
          src/lib/team/__tests__/system-prompt-context.test.ts \
          src/workers/processors/__tests__/agent-run.test.ts
  git commit -m "$(cat <<'EOF'
  refactor: bundle low-severity cleanups (vocab, destructure, test sturdiness)

  Four small wins consolidated into one commit:
  - Standardize 'no value yet' defaults on '(none yet)' (strategicPathId,
    channels, teamRoster, productDescription). Keep '(none)' for the
    distinct zero-count semantic of statusBreakdown and 'unknown' for
    state enums (productState, currentPhase).
  - Refactor Promise.all bundle in loadSystemPromptContext to object
    destructure so adding a 7th query is a one-line add, not a paired
    update of two arrays.
  - Pin runAgent's onEvent positional index (7) behind a named accessor
    so a future signature shift fails one place loudly instead of
    N tests silently passing.
  - Remove four dead teamSelectChain.limit.mockResolvedValueOnce stubs
    from agent-run.test.ts (post-fd9ee1a, loadSystemPromptContext is
    module-mocked so the underlying chain is no longer consumed).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review checklist

- [x] Each of the 4 LOW findings has a dedicated step.
- [x] No "TBD"/"implement later" hand-waves.
- [x] Build gate explicit (`pnpm tsc --noEmit --pretty false`).
- [x] `createTeamPlatformDeps` memoization explicitly OUT of scope (deferred for separate brainstorm).
- [x] Vocabulary changes specify the exact string-literal mapping; no ambiguity for the implementer.
