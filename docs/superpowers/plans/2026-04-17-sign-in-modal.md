# Sign-in Provider Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the direct-to-GitHub redirect on "Sign in" with a ShipFlare-owned provider picker modal, so users see on-app confirmation before OAuth and adding Google/Email later is a one-entry change.

**Architecture:** New client component `src/components/auth/sign-in-modal.tsx` wraps a native `<dialog>` element driven by a `providers` array; `landing-page.tsx` swaps its two inline `<form action={signInWithGitHub}>` sites for a button that opens the modal. The modal itself hosts the `<form action={provider.action}>` per provider, preserving the existing server action unchanged.

**Tech Stack:** Next.js 16 App Router, React 19, Auth.js v5 (beta), Tailwind, native HTML `<dialog>`, Playwright for E2E. Package manager: `bun`.

**Spec:** `docs/superpowers/specs/2026-04-17-sign-in-modal-design.md`

---

## File Structure

- **Create** `src/components/auth/sign-in-modal.tsx` — client component. Props `{ open, onClose, onBeforeSignIn? }`. Owns the `<dialog>` ref, effect that calls `showModal()` / `close()`, the `providers` array, and an inline `<GitHubIcon />` SVG.
- **Modify** `src/components/landing/landing-page.tsx` — remove two `<form action={signInWithGitHub}>` sites, add `signInOpen` / `signInContext` state, render `<SignInModal>` once. Keep `handleSignIn` and all other logic untouched.
- **Create** `e2e/tests/sign-in-modal.spec.ts` — unauthenticated Playwright spec covering open / close / provider-click.
- **Unchanged** `src/app/actions/auth.ts`, `src/lib/auth/index.ts`, all Auth.js callbacks, all scan-caching logic.

---

## Task 1: Create the sign-in modal component

**Files:**
- Create: `src/components/auth/sign-in-modal.tsx`

- [ ] **Step 1: Create the new directory and file**

```bash
mkdir -p src/components/auth
```

- [ ] **Step 2: Write the component**

Create `src/components/auth/sign-in-modal.tsx` with exactly this content:

```tsx
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { signInWithGitHub } from '@/app/actions/auth';

export interface SignInModalProps {
  open: boolean;
  onClose: () => void;
  onBeforeSignIn?: () => void;
}

interface Provider {
  id: 'github';
  label: string;
  icon: ReactNode;
  action: () => Promise<void>;
}

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

const PROVIDERS: Provider[] = [
  {
    id: 'github',
    label: 'Continue with GitHub',
    icon: <GitHubIcon />,
    action: signInWithGitHub,
  },
];

export function SignInModal({ open, onClose, onBeforeSignIn }: SignInModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === ref.current) {
      ref.current?.close();
    }
  }

  return (
    <dialog
      ref={ref}
      onClick={handleBackdropClick}
      aria-labelledby="sign-in-modal-title"
      className="
        m-auto w-[calc(100%-2rem)] max-w-[400px] p-0
        rounded-[var(--radius-sf-lg)]
        bg-sf-bg-secondary text-sf-text-primary
        shadow-[var(--shadow-sf-card)]
        backdrop:bg-black/40
        animate-sf-fade-in
      "
    >
      <div className="p-6">
        <div className="flex items-start justify-between mb-1">
          <h2
            id="sign-in-modal-title"
            className="text-[20px] font-semibold tracking-[-0.374px]"
          >
            Sign in to ShipFlare
          </h2>
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            className="
              -mr-2 -mt-1 p-2 cursor-pointer
              text-sf-text-tertiary hover:text-sf-text-primary
              transition-colors duration-200
            "
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.28 3.22a.75.75 0 00-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 101.06 1.06L8 9.06l3.72 3.72a.75.75 0 101.06-1.06L9.06 8l3.72-3.72a.75.75 0 00-1.06-1.06L8 6.94 4.28 3.22z" />
            </svg>
          </button>
        </div>
        <p className="text-[14px] text-sf-text-secondary mb-5 tracking-[-0.224px]">
          Choose how you want to sign in.
        </p>
        <div className="flex flex-col gap-2">
          {PROVIDERS.map((provider) => (
            <form key={provider.id} action={provider.action}>
              <button
                type="submit"
                onClick={() => onBeforeSignIn?.()}
                className="
                  w-full flex items-center justify-center gap-2.5
                  min-h-[44px] px-5 py-2.5
                  bg-sf-bg-dark-surface text-white
                  rounded-[var(--radius-sf-md)]
                  font-normal text-[17px] tracking-[-0.374px]
                  hover:bg-[#2c2c2e]
                  transition-all duration-200
                  cursor-pointer
                "
              >
                {provider.icon}
                {provider.label}
              </button>
            </form>
          ))}
        </div>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 3: Run type check to verify the new file compiles**

```bash
bun run lint
```

Expected: no errors related to `src/components/auth/sign-in-modal.tsx`. Any lint warnings about the unmodified rest of the codebase are pre-existing and out of scope.

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/sign-in-modal.tsx
git commit -m "feat(auth): add SignInModal component with provider picker"
```

---

## Task 2: Wire the modal into the landing page

**Files:**
- Modify: `src/components/landing/landing-page.tsx`

- [ ] **Step 1: Add the import at the top of the file**

At `src/components/landing/landing-page.tsx`, add after the existing `ShipFlareLogo` import (around line 9):

```tsx
import { SignInModal } from '@/components/auth/sign-in-modal';
```

- [ ] **Step 2: Add state hooks inside the `LandingPage` component**

Just after the existing `useState` declarations near the top of the component body (after `setData`, around line 34), add:

```tsx
const [signInOpen, setSignInOpen] = useState(false);
const [signInContext, setSignInContext] = useState<'nav' | 'unlock'>('nav');
```

- [ ] **Step 3: Replace the top-nav sign-in form**

Find the block at lines ~142-151:

```tsx
) : (
  <form action={signInWithGitHub}>
    <button
      type="submit"
      className="text-[14px] text-sf-link-dark hover:underline transition-colors duration-200 cursor-pointer inline-flex items-center min-h-[44px] px-2 tracking-[-0.224px]"
    >
      Sign in
    </button>
  </form>
)}
```

Replace with:

```tsx
) : (
  <button
    type="button"
    onClick={() => {
      setSignInContext('nav');
      setSignInOpen(true);
    }}
    className="text-[14px] text-sf-link-dark hover:underline transition-colors duration-200 cursor-pointer inline-flex items-center min-h-[44px] px-2 tracking-[-0.224px]"
  >
    Sign in
  </button>
)}
```

- [ ] **Step 4: Replace the unlock-CTA form**

Find the block at lines ~289-308:

```tsx
<form action={async () => { handleSignIn(); await signInWithGitHub(); }}>
  <button
    type="submit"
    className="
      flex items-center justify-center gap-2.5
      min-h-[44px] px-5 py-2.5
      bg-sf-bg-dark-surface text-white
      rounded-[var(--radius-sf-md)]
      font-normal text-[17px] tracking-[-0.374px]
      hover:bg-[#2c2c2e]
      transition-all duration-200
      cursor-pointer
    "
  >
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z" clipRule="evenodd" />
    </svg>
    Sign in with GitHub
  </button>
</form>
```

Replace with:

```tsx
<button
  type="button"
  onClick={() => {
    setSignInContext('unlock');
    setSignInOpen(true);
  }}
  className="
    flex items-center justify-center gap-2.5
    min-h-[44px] px-5 py-2.5
    bg-sf-bg-dark-surface text-white
    rounded-[var(--radius-sf-md)]
    font-normal text-[17px] tracking-[-0.374px]
    hover:bg-[#2c2c2e]
    transition-all duration-200
    cursor-pointer
  "
>
  Sign in to continue
</button>
```

Note: the inline GitHub icon is removed here on purpose — the provider choice now belongs in the modal, not in the trigger button. The trigger becomes provider-neutral copy.

- [ ] **Step 5: Render the modal once at the bottom of the component**

Find the closing `</main>` near the end of the `return (...)` block. Insert the modal *just before* `</main>`:

```tsx
      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        onBeforeSignIn={signInContext === 'unlock' ? handleSignIn : undefined}
      />
    </main>
  );
}
```

- [ ] **Step 6: Remove the now-unused direct import**

At the top of `landing-page.tsx`, find:

```tsx
import { signInWithGitHub } from '@/app/actions/auth';
```

Remove that line — the server action is no longer invoked directly from this file.

- [ ] **Step 7: Run lint and type check**

```bash
bun run lint
```

Expected: no new errors. If lint complains about `signInWithGitHub` still being used somewhere in the file, grep for it:

```bash
grep -n signInWithGitHub src/components/landing/landing-page.tsx
```

Expected: no matches. If there are stragglers, remove them.

- [ ] **Step 8: Smoke-test locally**

```bash
bun run dev:next
```

Open `http://localhost:3000` in a browser (unauthenticated session):

1. Click the top-nav `Sign in` — a centered modal appears titled `Sign in to ShipFlare`. Clicking outside the modal, pressing `Esc`, or clicking `×` all close it.
2. Paste any URL and run a scan. Scroll to the blurred results, click `Sign in to continue` — the same modal opens.
3. In the modal, click `Continue with GitHub` — the browser navigates to `github.com/login/oauth/authorize?...`. Abort before finishing OAuth.

If all three behaviors match, proceed. Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add src/components/landing/landing-page.tsx
git commit -m "feat(auth): route Sign in clicks through SignInModal"
```

---

## Task 3: Add Playwright smoke test

**Files:**
- Create: `e2e/tests/sign-in-modal.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `e2e/tests/sign-in-modal.spec.ts` with this content:

```ts
import { test, expect } from '@playwright/test';

test.describe('SignInModal (unauthenticated)', () => {
  test('top-nav Sign in opens the provider modal', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Sign in to ShipFlare' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  });

  test('Esc closes the modal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('× button closes the modal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Continue with GitHub navigates to GitHub OAuth', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Intercept the OAuth redirect before the browser follows it
    const requestPromise = page.waitForRequest((request) =>
      request.url().startsWith('https://github.com/login/oauth/authorize'),
    );

    await page.getByRole('button', { name: 'Continue with GitHub' }).click();

    const request = await requestPromise;
    expect(request.url()).toContain('client_id=');
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Make sure the Next dev server is NOT already running (the Playwright config owns `webServer`):

```bash
bun run test:e2e -- sign-in-modal
```

Expected: all 4 tests pass. If `waitForRequest` in the 4th test times out because Playwright's test runner has cookies blocking OAuth, you can relax that assertion to wait for the page to start navigating to `github.com` via `page.waitForURL(/github\.com/)` instead. Pick whichever resolves cleanly in the local run.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/sign-in-modal.spec.ts
git commit -m "test(e2e): cover SignInModal open/close/provider-click"
```

---

## Task 4: Final verification

- [ ] **Step 1: Lint once more**

```bash
bun run lint
```

Expected: zero new errors introduced by this change.

- [ ] **Step 2: Full e2e regression on the auth-adjacent suites**

```bash
bun run test:e2e -- sign-in-modal onboarding navigation
```

Expected: all tests pass. `onboarding` and `navigation` exercise the authenticated path and sign-out — they should be unaffected by this change, but running them confirms nothing regressed.

- [ ] **Step 3: Vitest unit suite**

```bash
bun run test
```

Expected: pre-existing unit tests pass. No new unit tests were added in this plan.

- [ ] **Step 4: Confirm the spec's non-goals are still non-violated**

```bash
git diff main -- src/app/actions/auth.ts src/lib/auth/ src/app/api/account/route.ts
```

Expected: empty diff. If anything shows up there, revert those hunks — the spec's non-goals explicitly ruled out touching server actions, Auth.js callbacks, and the account-delete route.

- [ ] **Step 5: Review the full diff against the spec**

```bash
git log --oneline main..HEAD
git diff main --stat
```

Expected: three commits (component, landing wiring, e2e test) touching exactly `src/components/auth/sign-in-modal.tsx`, `src/components/landing/landing-page.tsx`, and `e2e/tests/sign-in-modal.spec.ts`. No unrelated files.
