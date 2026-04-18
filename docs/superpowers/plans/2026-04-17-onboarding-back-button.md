# Onboarding Back Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Back" button to onboarding steps 1 and 2 so users who picked the wrong method (especially "or enter manually →") can return to step 0 without refreshing.

**Architecture:** The wizard's step state already lives in `OnboardingPage` (`src/app/onboarding/page.tsx`). Thread a new `onBack: () => void` prop into `ProfileReviewStep` and `ConnectAccountsStep`, render a `<Button variant="ghost">Back</Button>` next to each step's primary action, and pass `() => setStep(previous)` from the page. No state refactor, no new state, no API changes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind, existing `@/components/ui/button` primitive, Playwright for E2E. Package manager: `bun`.

**Spec:** `docs/superpowers/specs/2026-04-17-onboarding-back-button-design.md`

---

## File Structure

- **Modify** `src/components/onboarding/profile-review-step.tsx` — add `onBack` to `ProfileReviewStepProps`, destructure it, wrap the existing single submit button in a `flex items-center gap-3` row with a ghost Back button as its second child.
- **Modify** `src/components/onboarding/connect-accounts-step.tsx` — add `onBack` to `ConnectAccountsStepProps`, destructure it, insert a ghost Back button as the first child of the existing `flex items-center gap-3` action row (before `Skip for now`).
- **Modify** `src/app/onboarding/page.tsx` — pass `onBack={() => setStep(0)}` into `<ProfileReviewStep>` and `onBack={() => setStep(1)}` into `<ConnectAccountsStep>`.
- **Modify** `e2e/tests/onboarding.spec.ts` — add one new test exercising Back from step 1 → step 0, and Back from step 1 entered via "or enter manually →".
- **Unchanged** all API routes, DB schema, and step 0 chooser + sub-forms (`product-source-step.tsx`, `github-repo-selector.tsx`, URL sub-form).

---

## Task 1: Wire Back button through all three onboarding files

**Files:**
- Modify: `src/components/onboarding/profile-review-step.tsx`
- Modify: `src/components/onboarding/connect-accounts-step.tsx`
- Modify: `src/app/onboarding/page.tsx`

- [ ] **Step 1: Add `onBack` to `ProfileReviewStepProps` and destructure it**

Open `src/components/onboarding/profile-review-step.tsx`. At lines 8-11 the current interface reads:

```tsx
interface ProfileReviewStepProps {
  profile: ExtractedProfile;
  onSaved: () => void;
}
```

Replace with:

```tsx
interface ProfileReviewStepProps {
  profile: ExtractedProfile;
  onSaved: () => void;
  onBack: () => void;
}
```

On line 13 the current signature reads:

```tsx
export function ProfileReviewStep({ profile, onSaved }: ProfileReviewStepProps) {
```

Replace with:

```tsx
export function ProfileReviewStep({ profile, onSaved, onBack }: ProfileReviewStepProps) {
```

- [ ] **Step 2: Wrap the submit button in a flex row with a ghost Back button**

In the same file, lines 97-99 currently read:

```tsx
      <Button type="submit" disabled={loading || !name || !description}>
        {loading ? 'Saving...' : 'Save and continue'}
      </Button>
```

Replace with:

```tsx
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading || !name || !description}>
          {loading ? 'Saving...' : 'Save and continue'}
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
```

- [ ] **Step 3: Add `onBack` to `ConnectAccountsStepProps` and destructure it**

Open `src/components/onboarding/connect-accounts-step.tsx`. Lines 6-10 currently read:

```tsx
interface ConnectAccountsStepProps {
  onComplete: () => void;
  redditConnected?: boolean;
  xConnected?: boolean;
}
```

Replace with:

```tsx
interface ConnectAccountsStepProps {
  onComplete: () => void;
  onBack: () => void;
  redditConnected?: boolean;
  xConnected?: boolean;
}
```

Lines 12-16 currently read:

```tsx
export function ConnectAccountsStep({
  onComplete,
  redditConnected,
  xConnected,
}: ConnectAccountsStepProps) {
```

Replace with:

```tsx
export function ConnectAccountsStep({
  onComplete,
  onBack,
  redditConnected,
  xConnected,
}: ConnectAccountsStepProps) {
```

- [ ] **Step 4: Add a Back button before "Skip for now"**

In the same file, lines 80-84 currently read:

```tsx
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onComplete}>
          Skip for now
        </Button>
      </div>
```

Replace with:

```tsx
      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="ghost" onClick={onComplete}>
          Skip for now
        </Button>
      </div>
```

- [ ] **Step 5: Pass `onBack` from `OnboardingPage` into both steps**

Open `src/app/onboarding/page.tsx`. Lines 41-44 currently read:

```tsx
      {step === 1 && profile && (
        <ProfileReviewStep profile={profile} onSaved={handleProfileSaved} />
      )}
      {step === 2 && <ConnectAccountsStep onComplete={handleComplete} />}
```

Replace with:

```tsx
      {step === 1 && profile && (
        <ProfileReviewStep
          profile={profile}
          onSaved={handleProfileSaved}
          onBack={() => setStep(0)}
        />
      )}
      {step === 2 && (
        <ConnectAccountsStep
          onComplete={handleComplete}
          onBack={() => setStep(1)}
        />
      )}
```

- [ ] **Step 6: Run lint**

```bash
bun run lint
```

Expected: no new errors or warnings that mention `profile-review-step.tsx`, `connect-accounts-step.tsx`, or `onboarding/page.tsx`. Pre-existing issues in `src/workers/` are out of scope.

- [ ] **Step 7: Run the unit test suite to confirm nothing broke**

```bash
bun run test
```

Expected: 118 tests pass (no new tests added yet; this is a regression guard).

- [ ] **Step 8: Commit**

```bash
git add src/components/onboarding/profile-review-step.tsx src/components/onboarding/connect-accounts-step.tsx src/app/onboarding/page.tsx
git commit -m "feat(onboarding): add Back button to profile review and connect accounts steps"
```

---

## Task 2: Add E2E test for Back navigation

**Files:**
- Modify: `e2e/tests/onboarding.spec.ts`

- [ ] **Step 1: Add the new test at the end of the `Onboarding: complete flow` describe block**

Open `e2e/tests/onboarding.spec.ts`. At the current end of the `test.describe('Onboarding: complete flow', () => { ... })` block (after the second test at line 36-42, but before the closing `});` at line 43), insert:

```ts
  test('Back returns to chooser from step 1 (both extract and manual paths)', async ({
    authenticatedPage: page,
  }) => {
    await mockExtractSuccess(page);
    await page.goto('/onboarding');

    // Extract path: URL → step 1 → Back → chooser
    await expect(page.getByRole('heading', { name: 'Add your product' })).toBeVisible();
    await page.getByPlaceholder('https://your-product.com').fill('https://shipflare.dev');
    await page.getByRole('button', { name: 'Extract profile' }).click();

    await expect(page.getByRole('heading', { name: 'Review your profile' })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Add your product' })).toBeVisible();

    // Manual path: "or enter manually" → step 1 (empty) → Back → chooser
    await page.getByRole('button', { name: /enter manually/i }).click();
    await expect(page.getByRole('heading', { name: 'Review your profile' })).toBeVisible();
    await expect(page.getByLabel('Product name')).toHaveValue('');

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Add your product' })).toBeVisible();
  });
```

Verification: the existing `test.describe` block starts at line 5 and the second test ends at line 42. Your new test must be the third test inside the same describe (i.e. inserted before the closing `});` that terminates `test.describe('Onboarding: complete flow', ...)`).

Note on selectors:
- `getByRole('button', { name: 'Extract profile' })` — the button label in `UrlInputForm` is actually `'Scan website'`. Verify by reading `src/components/onboarding/product-source-step.tsx` line 172: `{loading ? 'Scanning...' : 'Scan website'}`. If it says `Scan website`, use that instead:

```ts
await page.getByRole('button', { name: 'Scan website' }).click();
```

The pre-existing test (`e2e/tests/onboarding.spec.ts:17`) uses `'Extract profile'`, which strongly suggests the button label is `'Extract profile'` somewhere — double-check by opening the file. Use whichever label actually appears in the DOM. If both selectors resolve ambiguously, prefer the label that matches the existing passing test at line 17.

- [ ] **Step 2: Run the new test**

```bash
bun run test:e2e -- onboarding
```

Expected behavior: the two pre-existing tests in `onboarding.spec.ts` fail for the same pre-existing workspace reason they fail on `main` (the authenticated-page fixture requires a test DB that may not be seeded in this environment). The new test is ALSO an authenticated-fixture test, so if the DB issue affects it, that's a pre-existing environment problem, not a regression.

**If the pre-existing tests pass in your environment:** the new test must also pass. Verify with the reporter summary.

**If the pre-existing tests fail in your environment:** confirm the failure signature matches what we've observed on `main` (timeout on `page.waitForURL('**/onboarding')` or `page.waitForURL('**/dashboard')`). If so, that's the workspace env issue and NOT caused by this task — proceed. If the new test fails for a DIFFERENT reason (e.g., selector mismatch, Back button not found), STOP and report.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/onboarding.spec.ts
git commit -m "test(e2e): cover onboarding Back button on step 1"
```

---

## Task 3: Final verification

- [ ] **Step 1: Lint**

```bash
bun run lint
```

Expected: zero new errors introduced. The same 7 pre-existing `src/workers/` issues are the only output.

- [ ] **Step 2: Unit tests**

```bash
bun run test
```

Expected: all pre-existing unit tests pass.

- [ ] **Step 3: Non-goals guard**

```bash
git diff main -- src/app/api/ src/lib/ src/app/onboarding/layout.tsx src/app/onboarding/error.tsx
```

Expected: empty output. The spec's non-goals ruled out API/DB changes; this verifies no such files were touched.

- [ ] **Step 4: File-count guard**

```bash
git diff main --name-only
```

Expected: exactly four files:
- `src/components/onboarding/profile-review-step.tsx`
- `src/components/onboarding/connect-accounts-step.tsx`
- `src/app/onboarding/page.tsx`
- `e2e/tests/onboarding.spec.ts`

(Plus the spec doc `docs/superpowers/specs/2026-04-17-onboarding-back-button-design.md` if that commit is still on the branch base.)

If other files appear, revert them — they are out of scope.

- [ ] **Step 5: Branch commit review**

```bash
git log --oneline main..HEAD
```

Expected: exactly two feature commits:
- `feat(onboarding): add Back button to profile review and connect accounts steps`
- `test(e2e): cover onboarding Back button on step 1`
