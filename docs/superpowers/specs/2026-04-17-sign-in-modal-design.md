# Sign-in Provider Modal

**Date:** 2026-04-17
**Status:** Approved design, pending implementation plan

## Problem

Clicking "Sign in" on the landing page today calls `signInWithGitHub` server
action directly, which immediately redirects to GitHub's OAuth consent screen.
Two UX problems:

1. Users don't see that the app is about to send them to GitHub until the
   redirect lands — there is no explicit "you're signing in with GitHub"
   confirmation on ShipFlare's own UI.
2. There is no place to add a second identity provider later (Google, Email,
   etc.) without repeating the same abrupt-redirect mistake.

## Goal

Intercept "Sign in" clicks with a ShipFlare-owned modal that:

- Names the app ("Sign in to ShipFlare") so users have an on-app confirmation
  step before the OAuth redirect.
- Presents identity providers as a list. Today: a single `Continue with GitHub`
  button. Adding Google or Email later is one array entry plus one server
  action branch — no layout redesign.
- Preserves existing post-OAuth behavior (scan-result caching, redirect to `/`).

## Non-goals

- No new identity providers in this change. Only the picker surface is added.
- No dedicated `/signin` route. Modal-only for now.
- No change to `DELETE /api/account`, token encryption, or Auth.js callbacks.
- No mobile bottom-sheet variant. Centered card on all viewports.

## UX

### Trigger points (two, both existing)

1. Top-nav `Sign in` button in `src/components/landing/landing-page.tsx` (line
   ~143-150, unauthenticated branch).
2. Blurred-results unlock CTA in the same file (line ~289-306), which today
   also runs `handleSignIn()` to cache scan results before the redirect.

Both currently render a `<form action={signInWithGitHub}>`. Both will change
to a `<button type="button" onClick={() => openSignIn()}>` that opens the
modal. The modal's provider button owns the form submission.

### Modal anatomy

- **Title:** `Sign in to ShipFlare`
- **Subtitle:** `Choose how you want to sign in.`
- **Provider list (vertical):**
  - `Continue with GitHub` — GitHub Octocat icon on the left, white label on
    GitHub-black (`#24292f`) background, rounded to `--radius-sf-md`, full
    width of the modal body, `min-h-[44px]`.
- **Legal footer:** Omitted for this change. ShipFlare has no `/terms` or
  `/privacy` pages today, and shipping the line without working links is
  worse than shipping nothing. Add when those pages exist.
- **Close affordances:** top-right `×` button, `Esc` key, click on backdrop.

### Dismissal behavior

- Closing the modal does nothing else — no navigation, no state reset. Scan
  results and the scanned URL stay on screen.
- Re-opening the modal from either trigger shows the same state (stateless
  picker; no form values to preserve).

### Viewport

- Desktop and mobile: centered card, `max-w-[400px]`, horizontal viewport
  margin `px-6`, vertical centering via `<dialog>` default.
- No bottom-sheet variant. If a future mobile polish pass adds one, it goes
  in a separate change.

### Motion

- Fade + subtle scale-in on open (150ms, `--ease-out-expo` from project
  tokens). Respect `prefers-reduced-motion`: no motion, just opacity.

### Accessibility

- Use the native `<dialog>` element with `showModal()` — gives us focus trap,
  backdrop, and `Esc` close for free in modern browsers.
- `aria-labelledby` points at the modal title.
- First focus lands on the first provider button (native `<dialog>` does this
  by default; no extra code).
- Provider buttons are real `<button type="submit">` inside a `<form>` that
  invokes the server action, so keyboard Enter works and there is no
  JS-required click handler on the submit path.

## Technical design

### New file: `src/components/auth/sign-in-modal.tsx`

Client component. Exports:

```tsx
'use client';

export interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  // Called right before the provider's server action runs. Used by the
  // unlock CTA to snapshot scan results into sessionStorage.
  onBeforeSignIn?: () => void;
}

export function SignInModal(props: SignInModalProps): JSX.Element | null;
```

Internals:

- A local `providers` array drives rendering:
  ```ts
  interface Provider {
    id: 'github';
    label: string;              // "Continue with GitHub"
    icon: ReactNode;            // <GitHubIcon />
    action: () => Promise<void>;// signInWithGitHub
  }
  ```
- Uses `useRef<HTMLDialogElement>(null)` + an effect that calls
  `dialog.showModal()` when `open` becomes true and `dialog.close()` when it
  becomes false.
- Listens to the dialog's native `close` event to call `onClose()` so Esc
  and backdrop-click stay in sync with parent state.
- Each provider renders as a `<form action={provider.action}>` with a single
  submit button inside. The button's `onClick` calls `onBeforeSignIn?.()`
  *before* the form submits — that's the hook the unlock CTA uses to cache
  scan results. Order matters: `onClick` fires before form submission in the
  browser event loop, so the cache write happens before the navigation.

### Changes in `src/components/landing/landing-page.tsx`

1. Add local state: `const [signInOpen, setSignInOpen] = useState(false);`
2. Add a state flag for which trigger opened it: `const [signInContext,
   setSignInContext] = useState<'nav' | 'unlock'>('nav');` — used to decide
   whether `onBeforeSignIn` should run `handleSignIn()`.
3. Replace the top-nav `<form action={signInWithGitHub}>` with a
   `<button type="button">` that sets `signInContext='nav'` and opens the
   modal.
4. Replace the unlock-CTA form similarly, setting `signInContext='unlock'`.
5. Render `<SignInModal open={signInOpen} onClose={() => setSignInOpen(false)}
   onBeforeSignIn={signInContext === 'unlock' ? handleSignIn : undefined} />`
   once at the bottom of the component.

No changes to `handleSignIn`, `signInWithGitHub`, `useEffect` restoration
logic, or `SESSION_KEY`/`SESSION_DATA_KEY`.

### Changes in `src/app/actions/auth.ts`

None for this change. The existing `signInWithGitHub` server action keeps its
current signature and body. Adding a future provider is a new exported
function, e.g. `signInWithGoogle`, and a new `providers` array entry — no
branching logic inside a single action.

### Icon

Inline SVG `<GitHubIcon />` component colocated in
`src/components/auth/sign-in-modal.tsx`. Use the canonical Octocat path from
GitHub's logo guidelines. 20x20. No new dependency.

## Tests

Playwright smoke test added as `e2e/tests/sign-in-modal.spec.ts`, following
the structure of neighbors such as `onboarding.spec.ts` and
`navigation.spec.ts`:

1. Visit `/` unauthenticated.
2. Click top-nav `Sign in` — assert modal is visible with title
   `Sign in to ShipFlare`.
3. Click `Continue with GitHub` — assert navigation starts toward
   `github.com/login/oauth/authorize` (intercept the request or assert on
   the outgoing URL; do not actually complete OAuth).
4. Reopen modal, press `Esc` — assert modal closes.

Unit test for the component itself is low value given how thin the logic is;
the Playwright test covers the meaningful behavior. If the existing project
has a `@testing-library/react` setup already in use, add a render-smoke test
that asserts the modal title renders when `open` is true — otherwise skip.

## Rollout

Single PR. No feature flag. No migration. No backfill. The two trigger sites
change in lockstep with the new component landing in the same commit.

## Open questions

None at design time. Decisions made:

- Copy: `Continue with GitHub` (option 1 of three presented).
- Mobile: centered card (bottom-sheet deferred).
- No `/signin` route — modal only.
- No `'use dialog'` polyfill; project targets modern browsers and `<dialog>`
  has full support in Chrome / Safari / Firefox as of 2022-2023.
