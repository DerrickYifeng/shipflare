# Onboarding Plan — Insert Products Row Before Skill Invocation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the fresh-onboarding crash where `/api/onboarding/plan` invokes the `generating-strategy` skill with `productId: null`, causing `write_strategic_path` to throw `product null not found for user <id>`. The plan route already has the full product data in `body.product` — just needs to INSERT the products row before invoking the skill.

**Architecture:** One-file fix in `src/app/api/onboarding/plan/route.ts`. The route's existing branch at line 227-235 queries `products WHERE userId` and uses `existingProduct[0]?.id ?? null`. Replace the `?? null` with an explicit INSERT path that uses `body.product` data when no row exists. Commit route's upsert at `commit/route.ts:175-192` (`if (prev) UPDATE`) already handles the case where the user later modifies fields in stage-plan — the product row created here is just refined, not replaced.

**Tech Stack:** TypeScript, Drizzle ORM, Next.js Route Handler, Vitest.

**The reproducer the user reported:**
```
[next] WRN [core:tools] Tool write_strategic_path failed in 153ms: write_strategic_path: product null not found for user e75309d4-cff6-4344-9ad4-d479583ad63d
```

This fires for any user reaching the plan step without a pre-existing products row (i.e., every fresh onboarding since 2026-05-02 commit `87694ae`).

---

## Pre-flight context (read once)

- Current broken code: `src/app/api/onboarding/plan/route.ts:227-240` — the query that returns `existingProduct[0]?.id ?? null` and passes it to `runStrategicPathSkill`.
- The route already receives the full product data in `body` (validated against the request schema at the top of the file). Search for the schema definition to confirm field names — they should match the products column shape.
- Products schema: `src/lib/db/schema/products.ts`. Has `uniqueIndex products_user_uq(user_id)` so two users can't have multiple products. Our INSERT must respect this — but the route already does the existence check, so the INSERT only fires when no row exists.
- Commit route upsert: `src/app/api/onboarding/commit/route.ts:170-213` — `if (prev) UPDATE products SET ... WHERE id = prev.id` (line 175-192) or `INSERT` (line 195-211). Either path correctly handles a pre-existing row from this fix.
- Daily ops are unaffected — `team.productId` is set by `provisionTeamForProduct` after commit, and `loadSystemPromptContext` reads from there. No agent-callable tool currently writes `products` (only `WriteStrategicPathTool` writes `strategic_paths` and reads `products`).
- Build gate: `pnpm tsc --noEmit --pretty false` exit 0.

---

## Task 1: INSERT products row in plan route when none exists

**Files:**
- Modify: `src/app/api/onboarding/plan/route.ts:222-240` — replace the existing `existingProduct` query block with an existence-check + INSERT path.
- Test (create or extend): `src/app/api/onboarding/plan/__tests__/route.test.ts` if it exists; else create a focused test file covering the new INSERT branch.

### Task 1 spec

**Replace** (`route.ts:222-240`):
```ts
try {
  // When the user hasn't committed a product row yet (fresh
  // onboarding), pass productId=null — the skill's tools tolerate
  // a null productId for the duration of the plan call. The commit
  // route later persists the product and binds the strategic path.
  const existingProduct = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  const path: StrategicPath = await runStrategicPathSkill({
    userId,
    productId: existingProduct[0]?.id ?? null,
    body,
    currentPhase,
    abortSignal: abortController.signal,
    onToolEvent: (event) => enqueue(event as unknown as Record<string, unknown>),
  });
```

**With** (`route.ts:222-...`):
```ts
try {
  // The skill's `write_strategic_path` tool requires a real
  // products.id (FK + notNull on strategic_paths.product_id). Resolve
  // an existing row if there is one; otherwise INSERT a fresh row
  // using the body fields the route already has. The commit route's
  // upsert path (commit/route.ts:175-192) refines whatever lands
  // here when the user clicks through stage-plan.
  const existingProduct = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  let productId: string;
  if (existingProduct[0]) {
    productId = existingProduct[0].id;
  } else {
    const [created] = await db
      .insert(products)
      .values({
        userId,
        name: body.product.name,
        description: body.product.description,
        valueProp: body.product.valueProp ?? null,
        keywords: body.product.keywords,
        url: body.product.url ?? null,
        targetAudience: body.product.targetAudience ?? null,
        category: body.product.category,
        state: body.state,
        launchDate: body.launchDate ?? null,
        launchedAt: body.launchedAt ?? null,
        // onboardingCompletedAt stays null until /commit; the commit
        // route stamps it when the user finalizes.
      })
      .returning({ id: products.id });
    productId = created.id;
  }

  const path: StrategicPath = await runStrategicPathSkill({
    userId,
    productId,                    // now always non-null
    body,
    currentPhase,
    abortSignal: abortController.signal,
    onToolEvent: (event) => enqueue(event as unknown as Record<string, unknown>),
  });
```

Also update `RunStrategicPathSkillArgs.productId` type at line 353 from `string | null` → `string` (and remove the now-stale comment about null tolerance). The `runStrategicPathSkill` body destructures `productId` and passes it into `deps` — the type tightening surfaces any other caller that still passes null at compile time. Grep `runStrategicPathSkill` to confirm only one caller.

### Edge cases to handle

- **INSERT race**: if two concurrent `/api/onboarding/plan` calls fire for the same user (browser double-click), the unique index `products_user_uq(user_id)` will throw on the second INSERT. Catch the duplicate-key error and re-query — return the row that's now there.

  Idiomatic Drizzle/postgres-js pattern (the same shape used by other upsert sites in the repo — grep for `code === '23505'` or `onConflictDoNothing` to find precedent). Pick whichever matches existing code:
  - **Option A** — `onConflictDoNothing` then re-select:
    ```ts
    const [created] = await db
      .insert(products)
      .values({...})
      .onConflictDoNothing({ target: products.userId })
      .returning({ id: products.id });
    if (created) {
      productId = created.id;
    } else {
      const [refetch] = await db.select({ id: products.id }).from(products).where(eq(products.userId, userId)).limit(1);
      productId = refetch.id;
    }
    ```
  - **Option B** — try/catch on the unique-violation:
    ```ts
    try {
      const [created] = await db.insert(products).values({...}).returning({ id: products.id });
      productId = created.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const [refetch] = await db.select({...}).from(products).where(eq(products.userId, userId)).limit(1);
        productId = refetch.id;
      } else {
        throw err;
      }
    }
    ```

  **Implementer judgment** — pick whichever matches an existing repo precedent (grep first). If neither pattern exists yet, prefer Option A (`onConflictDoNothing` is more declarative + lets postgres do the work).

- **Stale data**: a user who runs `/plan` then changes the product name in stage-plan and calls `/commit` will have the new name UPDATEd by the commit route's upsert path. No action needed here.

- **Schema field-name drift**: the products INSERT uses field names from `body.product`. Confirm the request schema (`Body` zod schema near the top of `route.ts`) actually has `name`, `description`, `valueProp`, `keywords`, `url`, `targetAudience`, `category`. If any field name differs, the INSERT call won't compile.

### Task 1 steps

- [ ] **Step 1: Pre-implementation grep**

  Run these to map the change surface + pick the unique-violation pattern:
  - `grep -n "products\." src/app/api/onboarding/plan/route.ts` — confirm `products` is already imported (it is — line 227 area).
  - `grep -rn "onConflictDoNothing\|code.*=.*'23505'\|isUniqueViolation\|UniqueConstraint" src/` — find any existing precedent.
  - `grep -n "runStrategicPathSkill" src/` — confirm one caller (so type tightening is safe).
  - Read the request schema in `route.ts` to confirm the body field names match the products column names you'll use in the INSERT.

- [ ] **Step 2: Write failing tests**

  In `src/app/api/onboarding/plan/__tests__/route.test.ts` (create if absent):
  1. `'INSERTs a products row when the user has none, and uses its id for the skill'` — mock `db.insert(products)...returning(...)` to return `[{ id: 'prod-new-1' }]`; assert `runForkSkill`/`runStrategicPathSkill` was called with `productId: 'prod-new-1'`.
  2. `'reuses the existing products row when one is present'` — mock the existence query to return `[{ id: 'prod-existing-9' }]`; assert NO INSERT occurred and `productId: 'prod-existing-9'` was passed.
  3. `'handles concurrent INSERT race via onConflictDoNothing path'` (or the chosen option) — mock the INSERT to return `[]` (no rows from onConflictDoNothing because another tx won the race); assert the route then re-selects and uses the racing transaction's id.

  If the test file doesn't exist and creating one requires significant scaffolding (mocking the SSE stream is non-trivial), **at minimum** add a focused unit test that exercises the new branch logic, even if you have to extract the resolve-or-insert logic into a small helper function.

- [ ] **Step 3: Run tests to verify they fail**

  Run: `pnpm vitest run src/app/api/onboarding/plan/__tests__/route.test.ts` (or wherever the new tests landed).
  Expected: tests fail (current code returns `null` for missing product).

- [ ] **Step 4: Implement the change**

  Apply the spec'd diff to `route.ts`. Pick the unique-violation pattern based on your grep findings. Tighten `RunStrategicPathSkillArgs.productId` type to `string`.

- [ ] **Step 5: Run tests to verify they pass**

  Run: `pnpm vitest run src/app/api/onboarding/plan/__tests__/route.test.ts`
  Expected: PASS.

- [ ] **Step 6: Run wider sweep**

  `pnpm vitest run src/app/api/onboarding/`
  Expected: all green (commit route tests + extract route tests should be unaffected).

- [ ] **Step 7: Type-check the build gate**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit code 0.

- [ ] **Step 8: Commit**

  ```bash
  git add src/app/api/onboarding/plan/route.ts \
          src/app/api/onboarding/plan/__tests__/route.test.ts
  git commit -m "$(cat <<'EOF'
  fix(onboarding/plan): insert products row before skill so write_strategic_path has a real productId

  Fresh-onboarding users hit "product null not found for user <id>"
  because the plan route passed productId=null to the generating-strategy
  skill, and write_strategic_path requires a real FK target. The route
  already receives the full product data in body.product — just needed
  to INSERT the products row when none exists.

  - Replace `existingProduct[0]?.id ?? null` with an explicit
    resolve-or-insert path using body.product/state/launchDate.
  - Tighten RunStrategicPathSkillArgs.productId from `string | null`
    to `string` (was always-broken-when-null).
  - Handle the concurrent-INSERT race via onConflictDoNothing.

  The commit route's existing upsert path (if (prev) UPDATE) refines
  whatever lands here when the user clicks through stage-plan.
  Daily-ops agents are unaffected — they read team.productId, which
  is set post-commit by provisionTeamForProduct.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review checklist

- [x] Single-file fix; matches the smallest-blast-radius diagnosis.
- [x] Concurrent-INSERT race explicitly handled (the `onConflictDoNothing` arm).
- [x] Type tightening (`string | null` → `string`) closes the contract drift that let this regression hide for ~2 days.
- [x] Test plan covers both new branches (INSERT + reuse) plus the race path.
- [x] Daily-ops impact assessed and confirmed zero (no agent-callable tool writes products; team.productId is post-commit only).
- [x] Build gate (`pnpm tsc --noEmit --pretty false`) explicit.
- [x] No platform sniffing; no schema migration; no API surface change visible to clients.
