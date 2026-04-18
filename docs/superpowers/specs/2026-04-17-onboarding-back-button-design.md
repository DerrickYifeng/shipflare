# Onboarding Back Button

**Date:** 2026-04-17
**Status:** Approved design, pending implementation plan

## Problem

`OnboardingPage` is a three-step wizard (`src/app/onboarding/page.tsx`) driven by
page-level `step` state (0..2). The chooser on step 0 is escape-friendly:
`GitHubRepoSelector` and the URL sub-form both have an `onBack` that returns to
the method chooser. The `"or enter manually →"` button on step 0 is the trap:
it calls `onExtracted({ url: '', name: '', ... })` with empty values, which
advances the parent to step 1 immediately. Once on step 1 (`ProfileReviewStep`)
or step 2 (`ConnectAccountsStep`), the user has no way back — neither component
exposes any backwards navigation.

A user who clicks "or enter manually →" by accident (or changes their mind and
wants to try the URL extractor instead) must refresh the page to restart.

## Goal

Add a "Back" button on steps 1 and 2 that returns to the previous step,
matching the existing `<Button variant="ghost">Back</Button>` pattern already
used inside `UrlInputForm` and `GitHubRepoSelector`.

## Non-goals

- No Back button on step 0 — it's the first step; intra-step method navigation
  (chooser ↔ GitHub sub-form ↔ URL sub-form) already works.
- No browser History / URL-param-driven step routing. `step` state remains
  local to the page component.
- No "remember the user's last chosen method" when returning to step 0; the
  chooser just re-renders as a chooser.
- No keyboard shortcuts.
- No change to the Step 2 "Skip for now" / "Connect" flow — Back is added as
  a sibling to Skip for now, not a replacement.
- No DB rollback on Back. Step 1's PUT `/api/onboarding/profile` is the only
  step that persists anything server-side, and it upserts; going back from
  step 2 to step 1 and re-submitting is idempotent.

## UX

### Step 0

Unchanged. Chooser has three entry points: GitHub, URL, "or enter manually".
The sub-forms' internal Back buttons stay as-is.

### Step 1 (`ProfileReviewStep`)

Current bottom-of-form action row has one button: `Save and continue`.
Add a Back button beside it, using the same visual pattern as `UrlInputForm`:

```tsx
<div className="flex items-center gap-3">
  <Button type="submit" disabled={loading}>
    {loading ? 'Saving...' : 'Save and continue'}
  </Button>
  <Button type="button" variant="ghost" onClick={onBack}>
    Back
  </Button>
</div>
```

Clicking Back sets parent step to 0. The `profile` state in `OnboardingPage`
remains in memory; if the user re-extracts via GitHub or URL, it is
overwritten. If the user chooses "or enter manually" again, `onExtracted`
resets it to empty and they land back on step 1 with cleared fields — this
matches current manual-entry semantics.

### Step 2 (`ConnectAccountsStep`)

Current bottom action row has one button: `Skip for now` (ghost). Add Back
beside it:

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

Clicking Back sets parent step to 1. The `profile` state is preserved
(step 1's PUT already saved it to DB), so the review form re-renders with
the last-submitted values (as held in page-level state).

## Technical design

### `src/app/onboarding/page.tsx`

Add `onBack` props to both step renders:

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

### `src/components/onboarding/profile-review-step.tsx`

Extend the `ProfileReviewStepProps` interface:

```tsx
interface ProfileReviewStepProps {
  profile: ExtractedProfile;
  onSaved: () => void;
  onBack: () => void;
}
```

Thread `onBack` through as the ghost button alongside Save. No other changes
to the component (form state, submit handler, error display all stay).

### `src/components/onboarding/connect-accounts-step.tsx`

Extend `ConnectAccountsStepProps`:

```tsx
interface ConnectAccountsStepProps {
  onComplete: () => void;
  onBack: () => void;
  redditConnected?: boolean;
  xConnected?: boolean;
}
```

Render Back as the first element in the action row, before "Skip for now".

## Tests

Extend `e2e/tests/onboarding.spec.ts` with one new test using the existing
`authenticatedPage` fixture and the existing `mockExtractSuccess` helper:

1. Visit `/onboarding`.
2. Fill URL, click `Extract profile` → on step 1.
3. Click `Back` → assert heading returns to `Add your product`.
4. Click `or enter manually →` → on step 1 with empty fields.
5. Click `Back` → assert chooser heading again.

No new unit tests — the components are presentational and the E2E test
covers the meaningful behavior. Step 2 → step 1 Back is symmetric to
step 1 → step 0 and does not need its own test.

## Rollout

Single PR. Three files touched, one test added. No flags, no migration.
