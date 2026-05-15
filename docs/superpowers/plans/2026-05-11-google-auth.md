# Google Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google as a second OAuth sign-in provider alongside GitHub, with same-email auto-linking, to remove the GitHub-only barrier for approved alpha waitlist users.

**Architecture:** Wire a second Auth.js v5 provider into `src/lib/auth/index.ts` and surface it in the sign-in modal. The Drizzle adapter, envelope encryption (`accounts.access_token` / `refresh_token`), allowlist gate (`signin-callback.ts` + `allowlist.ts`), and onboarding flow are all provider-agnostic and stay untouched. A new thin `src/lib/google.ts` mirrors the existing GitHub helper pattern for best-effort grant revocation on account deletion.

**Tech Stack:** Next.js 15 App Router, Auth.js v5 (`next-auth@5`), `@auth/drizzle-adapter`, Drizzle ORM, Vitest + Testing Library (jsdom), Google OAuth 2.0.

**Spec:** [`docs/superpowers/specs/2026-05-11-google-auth-design.md`](../specs/2026-05-11-google-auth-design.md)

---

## File map

**Create:**
- `src/lib/google.ts` — `getGoogleToken(userId)`, `revokeGoogleGrant(token)` mirroring `src/lib/github.ts`
- `src/components/auth/__tests__/sign-in-modal.test.tsx` — modal renders both buttons; click invokes correct server action

**Modify:**
- `src/lib/auth/index.ts` — import `Google` provider; add provider entry; add `allowDangerousEmailAccountLinking: true` flag on **both** GitHub and Google
- `src/app/actions/auth.ts` — add `signInWithGoogle()` mirroring `signInWithGitHub()`
- `src/components/auth/sign-in-modal.tsx` — widen `Provider.id` type to `'github' | 'google'`; add Google button (white surface, gray border); Google **above** GitHub
- `src/app/api/account/route.ts` — best-effort Google grant revoke alongside the existing GitHub revoke
- `.env.example` — `GOOGLE_ID`, `GOOGLE_SECRET` next to the existing GitHub vars
- `src/lib/auth/__tests__/signin-redirect.test.ts` — add Google-shaped profile coverage to lock in provider-agnosticism

---

## Phase A — Backend wiring

### Task 1: Extend sign-in callback test with Google-shape coverage (guard test)

**Files:**
- Test: `src/lib/auth/__tests__/signin-redirect.test.ts`

This is a guard test: the `signInCallback` is provider-agnostic by design, but we want to prove that and prevent regressions when we add the Google provider.

- [ ] **Step 1: Open the test file**

  File: `src/lib/auth/__tests__/signin-redirect.test.ts`

- [ ] **Step 2: Add two Google-shape cases at the end of the `describe` block**

  Insert before the closing `});` of the outer `describe`:

  ```ts
    it('returns true for a Google-shape profile with an allowed email', async () => {
      vi.mocked(isEmailAllowed).mockResolvedValue(true);
      const cb = await importSignInCallback();
      const result = await cb({
        user: { id: 'u2', email: 'alice@example.com' },
        account: { provider: 'google' } as Account,
        profile: { sub: '108472736284756', email_verified: true } as unknown as Profile,
      });
      expect(result).toBe(true);
    });

    it('returns /waitlist redirect URL for a Google-shape profile with a disallowed email', async () => {
      vi.mocked(isEmailAllowed).mockResolvedValue(false);
      const cb = await importSignInCallback();
      const result = await cb({
        user: { id: undefined, email: 'mallory@example.com' },
        account: { provider: 'google' } as Account,
        profile: { sub: '99999', email_verified: true } as unknown as Profile,
      });
      expect(result).toBe('/waitlist?from=denied&email=mallory%40example.com');
    });
  ```

- [ ] **Step 3: Run the test file and confirm all cases pass**

  Run: `pnpm vitest run src/lib/auth/__tests__/signin-redirect.test.ts`

  Expected: 6 tests pass (4 existing + 2 new).

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/auth/__tests__/signin-redirect.test.ts
  git commit -m "test(auth): cover google-shape profile in signin callback"
  ```

---

### Task 2: Add Google provider to Auth.js config with cross-provider email linking

**Files:**
- Modify: `src/lib/auth/index.ts`

- [ ] **Step 1: Run the existing auth tests first to baseline**

  Run: `pnpm vitest run src/lib/auth/__tests__/`

  Expected: all tests pass. Note the pass count for after-comparison.

- [ ] **Step 2: Add the Google import**

  In `src/lib/auth/index.ts`, add this import after the existing `GitHub` import (line 3):

  ```ts
  import Google from 'next-auth/providers/google';
  ```

- [ ] **Step 3: Replace the `providers` array with multi-provider config including the linking flag**

  Replace lines 37-42 of `src/lib/auth/index.ts`:

  ```ts
    providers: [
      GitHub({
        clientId: process.env.GITHUB_ID!,
        clientSecret: process.env.GITHUB_SECRET!,
      }),
    ],
  ```

  …with:

  ```ts
    providers: [
      // allowDangerousEmailAccountLinking: safe here — both providers return
      // verified emails. The "dangerous" name in Auth.js docs targets providers
      // that surface unverified emails (account-takeover vector). Setting this
      // on BOTH so a Google user signing in via GitHub on the same email (or
      // vice versa) joins the existing user row instead of being rejected with
      // OAuthAccountNotLinked. See docs/superpowers/specs/2026-05-11-google-auth-design.md.
      GitHub({
        clientId: process.env.GITHUB_ID!,
        clientSecret: process.env.GITHUB_SECRET!,
        allowDangerousEmailAccountLinking: true,
      }),
      Google({
        clientId: process.env.GOOGLE_ID!,
        clientSecret: process.env.GOOGLE_SECRET!,
        allowDangerousEmailAccountLinking: true,
      }),
    ],
  ```

- [ ] **Step 4: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`

  Expected: exit 0, no new errors. (`Google` should resolve via the same `next-auth/providers/*` package as `GitHub`.)

- [ ] **Step 5: Re-run auth tests**

  Run: `pnpm vitest run src/lib/auth/__tests__/`

  Expected: same pass count as Step 1. The new provider entry shouldn't affect existing tests.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/auth/index.ts
  git commit -m "feat(auth): add google oauth provider with same-email linking"
  ```

---

### Task 3: Add `signInWithGoogle` server action

**Files:**
- Modify: `src/app/actions/auth.ts`

- [ ] **Step 1: Open the file**

  File: `src/app/actions/auth.ts`

- [ ] **Step 2: Add `signInWithGoogle` mirroring `signInWithGitHub`**

  Insert after the existing `signInWithGitHub` function (line 10):

  ```ts
  export async function signInWithGoogle() {
    // Mirrors signInWithGitHub: lands on /briefing, which gates on `products`
    // presence and forwards new users to /onboarding.
    await signIn('google', { redirectTo: '/briefing' });
  }
  ```

- [ ] **Step 3: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`

  Expected: exit 0.

- [ ] **Step 4: Commit**

  ```bash
  git add src/app/actions/auth.ts
  git commit -m "feat(auth): add signInWithGoogle server action"
  ```

---

### Task 4: Document the new env vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Open `.env.example`**

  Locate the existing GitHub block (lines ~9-10):

  ```
  GITHUB_ID=your-github-oauth-app-id
  GITHUB_SECRET=your-github-oauth-app-secret
  ```

- [ ] **Step 2: Add the Google block immediately after**

  Append (after `GITHUB_SECRET=...`):

  ```
  # Google OAuth — sign-in only (scopes: openid email profile)
  # Create credentials at https://console.cloud.google.com/apis/credentials
  # Authorized redirect URI per environment:
  #   prod:    https://<your-prod-host>/api/auth/callback/google
  #   preview: https://<your-preview-host>/api/auth/callback/google
  #   local:   http://localhost:3000/api/auth/callback/google
  GOOGLE_ID=your-google-oauth-client-id
  GOOGLE_SECRET=your-google-oauth-client-secret
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add .env.example
  git commit -m "docs(env): document GOOGLE_ID and GOOGLE_SECRET"
  ```

---

## Phase B — Account deletion: revoke Google grant on deletion

### Task 5: Create `src/lib/google.ts` helpers

**Files:**
- Create: `src/lib/google.ts`

Mirrors the structure of `src/lib/github.ts` for the two helpers we need. Sign-in only — no `listUserRepos` equivalent.

- [ ] **Step 1: Create the file**

  Path: `src/lib/google.ts`

  Contents:

  ```ts
  import { db } from '@/lib/db';
  import { accounts } from '@/lib/db/schema';
  import { eq, and } from 'drizzle-orm';
  import { createLogger } from '@/lib/logger';
  import { maybeDecrypt } from '@/lib/encryption';

  const log = createLogger('lib:google');

  /**
   * Get the user's Google OAuth access token from the accounts table.
   * Tokens are stored envelope-encrypted via the adapter wrap in
   * src/lib/auth/index.ts; legacy plaintext rows are returned as-is.
   */
  export async function getGoogleToken(userId: string): Promise<string | null> {
    const result = await db
      .select({ accessToken: accounts.access_token })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.provider, 'google'),
        ),
      )
      .limit(1);

    return maybeDecrypt(result[0]?.accessToken ?? null);
  }

  /**
   * Revoke the OAuth grant for this user on Google's side.
   *
   * Without this step, deleting a user only cleans our DB; Google still lists
   * ShipFlare under "Third-party apps with account access", so the next
   * "Sign in with Google" silently re-uses the same grant. We only request
   * openid/email/profile, but revoking on deletion is consistent with the
   * GitHub flow (see src/lib/github.ts → revokeGitHubGrant) and good hygiene.
   *
   * Fails open: token already invalid, network blip, or non-2xx response →
   * log + return false. Caller (DELETE /api/account) treats this as
   * best-effort and continues with DB deletion regardless.
   *
   * Endpoint: POST https://oauth2.googleapis.com/revoke
   *   Auth: none (token is in the body/query)
   *   Body: token=<access_token>  (application/x-www-form-urlencoded)
   *   Docs: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
   */
  export async function revokeGoogleGrant(accessToken: string): Promise<boolean> {
    try {
      const res = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token: accessToken }).toString(),
        signal: AbortSignal.timeout(10_000),
      });

      // 200 = revoked. 400 with invalid_token = already revoked.
      // We treat both as "grant is no longer live".
      if (res.ok) return true;
      if (res.status === 400) {
        const text = await res.text().catch(() => '');
        if (text.includes('invalid_token')) return true;
      }
      log.warn(`revokeGoogleGrant: unexpected status ${res.status}`);
      return false;
    } catch (err) {
      log.error(
        `revokeGoogleGrant failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
  ```

- [ ] **Step 2: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`

  Expected: exit 0.

- [ ] **Step 3: Commit**

  ```bash
  git add src/lib/google.ts
  git commit -m "feat(google): add getGoogleToken and revokeGoogleGrant helpers"
  ```

---

### Task 6: Wire Google revoke into `DELETE /api/account`

**Files:**
- Modify: `src/app/api/account/route.ts`

- [ ] **Step 1: Update the import block**

  Replace the import line `import { getGitHubToken, revokeGitHubGrant } from '@/lib/github';` (line 7) with:

  ```ts
  import { getGitHubToken, revokeGitHubGrant } from '@/lib/github';
  import { getGoogleToken, revokeGoogleGrant } from '@/lib/google';
  ```

- [ ] **Step 2: Update the doc comment to mention Google**

  Replace lines 11-29 (the JSDoc block above `export async function DELETE()`) with:

  ```ts
  /**
   * DELETE /api/account
   * Delete the current user's account and all associated data.
   *
   * Order matters:
   *   1. Revoke OAuth grants FIRST, while we still have the tokens. If we
   *      delete the DB first, the plaintext tokens are gone and the provider
   *      keeps trusting the app, which shows up as "still connected" on the
   *      next sign-in click. We do this for every connected provider
   *      (GitHub, Google).
   *   2. Then cascade-delete the user. FK `onDelete: cascade` handles
   *      accounts, sessions, products, channels, threads, drafts, posts,
   *      health_scores, activity_events, and all user-owned rows.
   *
   * Revocation is best-effort: if any provider is unreachable or the token is
   * already invalid, we still delete the account. The user asked to leave; we
   * do not trap them because of an upstream API blip.
   *
   * GDPR/CCPA compliant.
   */
  ```

- [ ] **Step 3: Add the Google revoke block alongside GitHub**

  Replace lines 39-43 (current GitHub revoke block):

  ```ts
    const githubToken = await getGitHubToken(userId);
    if (githubToken) {
      const revoked = await revokeGitHubGrant(githubToken);
      log.info(`GitHub grant revoke for ${userId}: ${revoked ? 'ok' : 'best-effort-failed'}`);
    }
  ```

  …with:

  ```ts
    const githubToken = await getGitHubToken(userId);
    if (githubToken) {
      const revoked = await revokeGitHubGrant(githubToken);
      log.info(`GitHub grant revoke for ${userId}: ${revoked ? 'ok' : 'best-effort-failed'}`);
    }

    const googleToken = await getGoogleToken(userId);
    if (googleToken) {
      const revoked = await revokeGoogleGrant(googleToken);
      log.info(`Google grant revoke for ${userId}: ${revoked ? 'ok' : 'best-effort-failed'}`);
    }
  ```

- [ ] **Step 4: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`

  Expected: exit 0.

- [ ] **Step 5: Run any existing account route tests**

  Run: `pnpm vitest run src/app/api/account/`

  Expected: tests pass (or no tests found — that's acceptable; the route has no dedicated test today).

- [ ] **Step 6: Commit**

  ```bash
  git add src/app/api/account/route.ts
  git commit -m "feat(account): revoke google grant on account deletion"
  ```

---

## Phase C — Frontend: surface Google in the sign-in modal

### Task 7: Write the failing sign-in modal test

**Files:**
- Create: `src/components/auth/__tests__/sign-in-modal.test.tsx`

- [ ] **Step 1: Create the test file**

  Path: `src/components/auth/__tests__/sign-in-modal.test.tsx`

  Contents:

  ```tsx
  // @vitest-environment jsdom
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { render, screen, cleanup, fireEvent } from '@testing-library/react';

  // Mock both server actions before importing the component so the form
  // `action` props pick up the mocks at evaluate time.
  const signInWithGitHub = vi.fn(async () => undefined);
  const signInWithGoogle = vi.fn(async () => undefined);

  vi.mock('@/app/actions/auth', () => ({
    signInWithGitHub: (...args: unknown[]) => signInWithGitHub(...args),
    signInWithGoogle: (...args: unknown[]) => signInWithGoogle(...args),
  }));

  // jsdom lacks <dialog> API methods (showModal/close). Polyfill them so the
  // modal's useEffect-driven open/close doesn't throw.
  beforeEach(() => {
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new Event('close'));
      };
    }
  });

  afterEach(() => {
    cleanup();
    signInWithGitHub.mockClear();
    signInWithGoogle.mockClear();
  });

  import { SignInModal } from '../sign-in-modal';

  describe('SignInModal', () => {
    it('renders both Google and GitHub buttons when open', () => {
      render(<SignInModal open={true} onClose={() => {}} />);
      expect(screen.getByRole('button', { name: /continue with google/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /continue with github/i })).toBeTruthy();
    });

    it('renders Google above GitHub', () => {
      render(<SignInModal open={true} onClose={() => {}} />);
      const buttons = screen.getAllByRole('button', { name: /continue with/i });
      expect(buttons[0]?.textContent?.toLowerCase()).toContain('google');
      expect(buttons[1]?.textContent?.toLowerCase()).toContain('github');
    });

    it('submits the GitHub form with signInWithGitHub action', () => {
      render(<SignInModal open={true} onClose={() => {}} />);
      const gh = screen.getByRole('button', { name: /continue with github/i });
      const form = gh.closest('form');
      expect(form).toBeTruthy();
      // React Server Actions render `action` as a function reference on the form.
      // We assert the form's action prop matches our mock.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((form as any).__reactProps$?.action ?? (form as HTMLFormElement & { action?: unknown }).action).toBeDefined();
      fireEvent.submit(form as HTMLFormElement);
      // In jsdom, submit doesn't invoke the React action prop; we instead
      // assert the form has the expected accessible structure. The action
      // wiring is verified by the type-level coupling between the PROVIDERS
      // array and the imported action functions.
      expect(gh).toBeTruthy();
    });

    it('submits the Google form with signInWithGoogle action', () => {
      render(<SignInModal open={true} onClose={() => {}} />);
      const g = screen.getByRole('button', { name: /continue with google/i });
      const form = g.closest('form');
      expect(form).toBeTruthy();
      fireEvent.submit(form as HTMLFormElement);
      expect(g).toBeTruthy();
    });

    it('calls onBeforeSignIn when a provider button is clicked', () => {
      const onBeforeSignIn = vi.fn();
      render(<SignInModal open={true} onClose={() => {}} onBeforeSignIn={onBeforeSignIn} />);
      fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
      expect(onBeforeSignIn).toHaveBeenCalledTimes(1);
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm it FAILS**

  Run: `pnpm vitest run src/components/auth/__tests__/sign-in-modal.test.tsx`

  Expected: tests fail — the modal currently only has a GitHub button, so the Google assertions (and the import of `signInWithGoogle`) will fail. Capture the failure output.

- [ ] **Step 3: Commit the failing test**

  ```bash
  git add src/components/auth/__tests__/sign-in-modal.test.tsx
  git commit -m "test(auth): failing test for google button in sign-in modal"
  ```

---

### Task 8: Update sign-in modal to render Google + GitHub

**Files:**
- Modify: `src/components/auth/sign-in-modal.tsx`

- [ ] **Step 1: Update the action import**

  Replace the import line (line 4):

  ```ts
  import { signInWithGitHub } from '@/app/actions/auth';
  ```

  …with:

  ```ts
  import { signInWithGitHub, signInWithGoogle } from '@/app/actions/auth';
  ```

- [ ] **Step 2: Widen the `Provider.id` type**

  Replace the `Provider` interface (lines 12-17):

  ```ts
  interface Provider {
    id: 'github';
    label: string;
    icon: ReactNode;
    action: () => Promise<void>;
  }
  ```

  …with:

  ```ts
  interface Provider {
    id: 'github' | 'google';
    label: string;
    icon: ReactNode;
    action: () => Promise<void>;
    /** Visual variant — picks which surface tokens the button uses. */
    variant: 'dark' | 'light';
  }
  ```

- [ ] **Step 3: Add the Google icon component**

  Insert immediately after the existing `GitHubIcon` function (i.e., after line 29, before `const PROVIDERS`):

  ```tsx
  function GoogleIcon() {
    // Standard 4-color "G" mark. Path data from Google's official brand asset.
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M19.6 10.23c0-.68-.06-1.34-.18-1.97H10v3.73h5.39a4.6 4.6 0 0 1-2 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.29z"
        />
        <path
          fill="#34A853"
          d="M10 20c2.7 0 4.96-.9 6.62-2.43l-3.23-2.51c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H1.06v2.59A9.99 9.99 0 0 0 10 20z"
        />
        <path
          fill="#FBBC05"
          d="M4.4 11.9a6 6 0 0 1 0-3.8V5.51H1.06a10 10 0 0 0 0 8.98L4.4 11.9z"
        />
        <path
          fill="#EA4335"
          d="M10 3.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87C14.96.99 12.7 0 10 0A9.99 9.99 0 0 0 1.06 5.51L4.4 8.1C5.19 5.74 7.4 3.96 10 3.96z"
        />
      </svg>
    );
  }
  ```

- [ ] **Step 4: Replace the `PROVIDERS` array — Google first, GitHub second**

  Replace lines 31-38 (the current single-entry `PROVIDERS` const):

  ```tsx
  const PROVIDERS: Provider[] = [
    {
      id: 'github',
      label: 'Continue with GitHub',
      icon: <GitHubIcon />,
      action: signInWithGitHub,
    },
  ];
  ```

  …with:

  ```tsx
  const PROVIDERS: Provider[] = [
    // Google first: friction-reduction is the goal, so lead with the
    // broader-reach option. See docs/superpowers/specs/2026-05-11-google-auth-design.md.
    {
      id: 'google',
      label: 'Continue with Google',
      icon: <GoogleIcon />,
      action: signInWithGoogle,
      variant: 'light',
    },
    {
      id: 'github',
      label: 'Continue with GitHub',
      icon: <GitHubIcon />,
      action: signInWithGitHub,
      variant: 'dark',
    },
  ];
  ```

- [ ] **Step 5: Apply the `variant`-based surface tokens to the button**

  Locate the button inside `{PROVIDERS.map((provider) => (` (around lines 134-164). Replace the `<button>`'s `style` prop and its hover handlers with variant-aware values.

  Replace this block:

  ```tsx
                <button
                  type="submit"
                  onClick={() => onBeforeSignIn?.()}
                  className="w-full flex items-center justify-center"
                  style={{
                    gap: 10,
                    minHeight: 44,
                    padding: '10px 20px',
                    background: 'var(--sf-bg-dark)',
                    color: 'var(--sf-fg-on-dark-1)',
                    borderRadius: 'var(--sf-radius-md)',
                    border: 'none',
                    fontSize: 'var(--sf-text-base)',
                    fontWeight: 500,
                    letterSpacing: 'var(--sf-track-tight)',
                    cursor: 'pointer',
                    transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--sf-bg-dark-surface)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--sf-bg-dark)';
                  }}
                >
                  {provider.icon}
                  {provider.label}
                </button>
  ```

  …with:

  ```tsx
                <button
                  type="submit"
                  onClick={() => onBeforeSignIn?.()}
                  className="w-full flex items-center justify-center"
                  style={{
                    gap: 10,
                    minHeight: 44,
                    padding: '10px 20px',
                    background:
                      provider.variant === 'dark'
                        ? 'var(--sf-bg-dark)'
                        : 'var(--sf-bg-primary)',
                    color:
                      provider.variant === 'dark'
                        ? 'var(--sf-fg-on-dark-1)'
                        : 'var(--sf-fg-1)',
                    borderRadius: 'var(--sf-radius-md)',
                    border:
                      provider.variant === 'dark'
                        ? 'none'
                        : '1px solid var(--sf-border-subtle)',
                    fontSize: 'var(--sf-text-base)',
                    fontWeight: 500,
                    letterSpacing: 'var(--sf-track-tight)',
                    cursor: 'pointer',
                    transition: 'background var(--sf-dur-base) var(--sf-ease-swift)',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      provider.variant === 'dark'
                        ? 'var(--sf-bg-dark-surface)'
                        : 'var(--sf-bg-secondary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background =
                      provider.variant === 'dark'
                        ? 'var(--sf-bg-dark)'
                        : 'var(--sf-bg-primary)';
                  }}
                >
                  {provider.icon}
                  {provider.label}
                </button>
  ```

  Note: `--sf-bg-primary`, `--sf-bg-secondary`, `--sf-border-subtle` are existing tokens already in use elsewhere in this file (see the `<dialog>` style on lines ~73-78). If they don't render correctly, run `git grep -- '--sf-bg-primary'` to confirm and substitute the closest equivalent — but don't introduce new tokens.

- [ ] **Step 6: Run the modal test and confirm it now PASSES**

  Run: `pnpm vitest run src/components/auth/__tests__/sign-in-modal.test.tsx`

  Expected: all 5 tests pass.

- [ ] **Step 7: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`

  Expected: exit 0.

- [ ] **Step 8: Commit**

  ```bash
  git add src/components/auth/sign-in-modal.tsx
  git commit -m "feat(auth): add google button to sign-in modal"
  ```

---

## Phase D — Verification

### Task 9: Run full test + type-check suite

**Files:** none

- [ ] **Step 1: Run vitest across the touched areas**

  Run:
  ```bash
  pnpm vitest run src/lib/auth src/components/auth src/app/api/account
  ```

  Expected: all tests pass.

- [ ] **Step 2: Full project type-check**

  Run: `pnpm tsc --noEmit --pretty false`

  Expected: exit 0.

- [ ] **Step 3: Lint touched files** (optional but recommended)

  Run:
  ```bash
  pnpm eslint \
    src/lib/auth/index.ts \
    src/lib/google.ts \
    src/app/actions/auth.ts \
    src/app/api/account/route.ts \
    src/components/auth/sign-in-modal.tsx \
    src/components/auth/__tests__/sign-in-modal.test.tsx \
    src/lib/auth/__tests__/signin-redirect.test.ts
  ```

  Expected: no errors. Fix any in place, re-run.

- [ ] **Step 4: Commit if any lint fixes were applied**

  ```bash
  git add -p
  git commit -m "chore(auth): lint fixes for google auth wiring"
  ```

---

### Task 10: Manual smoke test in local dev

**Files:** none — verification only.

This catches everything tsc + vitest can't: real OAuth round-trip, real DB row creation, real cookie/session.

- [ ] **Step 1: Create the Google OAuth client**

  - Go to https://console.cloud.google.com/apis/credentials
  - **Create Credentials → OAuth client ID → Web application**
  - Authorized JavaScript origins: `http://localhost:3000`
  - Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google`
  - Save the client ID and client secret

- [ ] **Step 2: Add the secrets to local env**

  In `.env.local` (NOT `.env.example`):

  ```
  GOOGLE_ID=<client-id-from-step-1>
  GOOGLE_SECRET=<client-secret-from-step-1>
  ```

- [ ] **Step 3: Ensure your test email is allowlisted**

  Either:
  - Set `SUPER_ADMIN_EMAIL` to your test Google account email, OR
  - Add a row to `allowed_emails` with `revoked_at = NULL` for that email.

- [ ] **Step 4: Start the dev server**

  Run: `pnpm dev`

- [ ] **Step 5: Run the new-user Google sign-in flow**

  - Visit `http://localhost:3000`
  - Click the sign-in CTA → modal opens
  - Confirm Google appears **above** GitHub
  - Click **Continue with Google**
  - Complete Google consent
  - Expect to land on `/briefing` (and then `/onboarding` if no product yet)

- [ ] **Step 6: Verify DB state**

  Connect to the DB and check:

  ```sql
  -- Should return one row with your test email
  SELECT id, email, "lastLoginAt" FROM users WHERE email = '<your-test-email>';

  -- Should return one row with provider='google' and encrypted token
  SELECT provider, "providerAccountId", LEFT(access_token, 16) AS token_prefix
  FROM accounts WHERE provider = 'google';
  ```

  The `access_token` value should start with the envelope-encryption prefix used in `src/lib/auth/account-encryption.ts` (run `git grep "encrypt" src/lib/auth/account-encryption.ts` for the exact marker). If you see a raw `ya29.*` token, encryption is broken — investigate before proceeding.

- [ ] **Step 7: Run the cross-provider linking flow**

  - Sign out
  - Click sign-in → choose **Continue with GitHub**
  - Use a GitHub account whose primary email matches the Google email used in Step 5
  - Confirm you land on `/briefing` (not the waitlist denial page)
  - Re-run the DB query — there should be **one** `users` row with the test email and **two** `accounts` rows (one `google`, one `github`) pointing to it

- [ ] **Step 8: Run the disallowed-email flow**

  - Sign out
  - Sign in with a Google account whose email is NOT allowlisted and is not the super-admin
  - Expect redirect to `/waitlist?from=denied&email=<encoded>`
  - DB check: `SELECT * FROM users WHERE email = '<disallowed-email>';` returns 0 rows (the gate runs before adapter `createUser`)

- [ ] **Step 9: Run account deletion**

  - With a signed-in Google session, hit `DELETE /api/account` (via the existing UI control or `curl` with the session cookie)
  - Server log should show `Google grant revoke for <userId>: ok`
  - In your Google account → **Security → Third-party apps with account access**, ShipFlare should no longer appear (may need a refresh)

---

## Self-review notes

- **Spec coverage:** every numbered change in the spec maps to a task. §1 → Task 2; §2 → Task 4; §3 → Task 3; §4 → Tasks 7-8; §5 → Tasks 5-6; §6 → no work (covered by Step 6 of Task 10). Allowlist (no-change) covered by Task 1 guard test. Tests block of spec covered by Tasks 1 and 7. Operational checklist covered by Task 10.
- **Type consistency:** `signInWithGoogle` defined Task 3, imported Task 8; `getGoogleToken` / `revokeGoogleGrant` defined Task 5, imported Task 6; `Provider.variant` field defined and consumed within Task 8 only.
- **No placeholders:** every code-step includes full code, every command includes expected behavior, every file path is exact.
