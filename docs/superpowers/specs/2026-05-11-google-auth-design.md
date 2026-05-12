# Google Auth — Design

**Date:** 2026-05-11
**Status:** Approved (ready for implementation plan)

## Goal

Add Google as a second OAuth sign-in provider alongside the existing GitHub
provider. Motivation: alpha-signup friction reduction. Approved waitlist
applicants who don't have a GitHub account can't currently sign in; Google
covers the gap with no strategic shift away from GitHub.

## Non-goals

- Replacing or deprecating GitHub auth.
- Touching the GitHub-as-product-source onboarding flow in `stage-source.tsx`
  (that's an unrelated "import from a repo" feature).
- Requesting any Google API scopes beyond `openid email profile` — no Drive,
  Calendar, or any Google API integration.
- Building a "linked accounts" management UI. Auto-linking by verified email
  is invisible to the user, and that's intentional.
- Migrating existing users. No data backfill required.

## Architecture summary

GitHub here is auth-only — the product channels are Reddit and X. Adding a
parallel OAuth provider stays inside the existing Auth.js v5 + Drizzle
adapter setup. The allowlist gate, account-token envelope encryption,
sign-in callback, and onboarding flow are all provider-agnostic and need
no changes.

The one cross-cutting decision is account linking: enable
`allowDangerousEmailAccountLinking: true` on **both** providers so that a
user signing in with Google using an email already tied to a GitHub
account (or vice versa) joins the existing user row instead of being
rejected or duplicated. This is safe because both GitHub and Google
return verified emails — the "dangerous" name in Auth.js docs targets
providers that surface unverified emails, which is not the case here.

## Changes

### 1. Auth provider config — `src/lib/auth/index.ts`

- Import `Google` from `next-auth/providers/google`.
- Add Google provider entry:
  ```ts
  Google({
    clientId: process.env.GOOGLE_ID!,
    clientSecret: process.env.GOOGLE_SECRET!,
    allowDangerousEmailAccountLinking: true,
  }),
  ```
- Add `allowDangerousEmailAccountLinking: true` to the existing GitHub
  provider so linking works in either direction (a Google user who later
  signs in with GitHub on the same email lands on the same row).
- `events.signIn`: the existing branch already covers non-GitHub providers
  by stamping only `lastLoginAt`. No `googleId` column is needed — the
  link is the `accounts` table row keyed on `(provider, providerAccountId)`.

### 2. Env vars — `.env.example`

Add next to the existing GitHub block:

```
# Google OAuth — sign-in only (openid email profile)
# Create credentials at https://console.cloud.google.com/apis/credentials
# Authorized redirect URI: https://<host>/api/auth/callback/google
GOOGLE_ID=your-google-oauth-client-id
GOOGLE_SECRET=your-google-oauth-client-secret
```

### 3. Server action — `src/app/actions/auth.ts`

Add `signInWithGoogle()` mirroring `signInWithGitHub()`:

```ts
export async function signInWithGoogle() {
  await signIn('google', { redirectTo: '/briefing' });
}
```

Same `/briefing` landing target — that page already gates on `products`
presence and forwards first-time users to `/onboarding`, so it works for
both new and returning users regardless of provider.

### 4. Sign-in modal — `src/components/auth/sign-in-modal.tsx`

- Widen the `Provider` discriminator: `id: 'github' | 'google'`.
- Add a Google "G" SVG component (4-color logo).
- Append a Google provider entry to the `PROVIDERS` array, ordered
  **above** GitHub. Friction-reduction is the goal; Google reaches the
  broader audience, so it leads.
- Style the Google button distinctly from the GitHub button so the two
  providers don't read as a single styled cluster:
  - GitHub: existing dark surface (`--sf-bg-dark` / `--sf-fg-on-dark-1`)
  - Google: white surface, subtle gray border, dark text — matches
    Google brand conventions and provides visual separation between the
    two options.
- The header copy ("Choose how you want to sign in.") already fits a
  multi-provider modal; no copy change needed.

### 5. Account deletion — `src/app/api/account/route.ts`

Add best-effort Google grant revocation alongside the existing GitHub
revocation. The pattern mirrors the GitHub helper exactly:

- New file `src/lib/google.ts` exporting:
  - `getGoogleToken(userId): Promise<string | null>` — looks up the
    user's `accounts` row where `provider = 'google'`, decrypts via
    `decryptAccount`, returns `access_token` or `null`.
  - `revokeGoogleGrant(token): Promise<boolean>` — POSTs to
    `https://oauth2.googleapis.com/revoke?token=<token>`, returns
    `true` on 2xx, logs and returns `false` otherwise.
- In `DELETE /api/account`, after the GitHub revoke block, do the
  Google revoke. Both are best-effort: failures are logged, never block
  account deletion.

Rationale for including this even though we only request basic scopes:
consistency with the GitHub flow, hygiene (token leaves the door, not
just the row), and it costs ~30 LOC.

### 6. Token encryption — no work needed

The `linkAccount` / `getAccount` adapter wrap in `src/lib/auth/index.ts`
already envelope-encrypts whatever the provider returns. Google's
`access_token`, `refresh_token`, and `id_token` flow through the same
path automatically. No schema change.

## Account-linking edge cases

With `allowDangerousEmailAccountLinking: true` on both providers:

| Scenario | Behavior |
|---|---|
| First-time Google sign-in, new email | Creates user, links Google account row. |
| First-time Google sign-in, email matches existing GitHub user | Links Google account row to the existing user. User now has two `accounts` rows for one `users` row. |
| Returning Google sign-in | Standard Auth.js path — finds account row, loads user. |
| Google email is unverified | Auth.js's Google provider only emits the profile if `email_verified` is true; unverified emails never reach `signInCallback`. |
| User changes their Google primary email | The `(provider, providerAccountId)` link is on Google's stable `sub`, not the email. Email change doesn't break the link. |

## Allowlist behavior

`signInCallback` already gates by normalized email. It runs against
whatever email the provider returns and is provider-agnostic. Adding
Google requires no changes to `src/lib/auth/signin-callback.ts` or
`src/lib/auth/allowlist.ts`.

## Tests

- **Extend** `src/lib/auth/__tests__/signin-redirect.test.ts` — add a
  case asserting `signInCallback` returns `true` when given a Google-shaped
  profile (`sub` instead of GitHub's `id`/`login`) whose email is in the
  allowlist, and returns the `/waitlist` redirect URL when the email is
  not allowed. The callback doesn't inspect provider-specific fields, so
  the test is really proving "the gate stays provider-agnostic."
- **New** `src/components/auth/__tests__/sign-in-modal.test.tsx` —
  assert both Google and GitHub buttons render with the right labels,
  that clicking each submits the matching server action, and that the
  Google button is rendered before GitHub.
- **No new test** for adapter encryption. The Google path uses the same
  `encryptAccount` / `decryptAccount` code already covered by
  `account-encryption.test.ts`.
- **No new test** for `revokeGoogleGrant` — it's a thin best-effort fetch
  wrapper; the GitHub equivalent isn't unit-tested either. If we add one
  later, it should also cover the GitHub version for consistency.

## Operational checklist

1. Create OAuth client in Google Cloud Console:
   - Type: Web application
   - Authorized JavaScript origins: production and preview domains
   - Authorized redirect URIs: `https://<host>/api/auth/callback/google`
     for every environment that needs Google sign-in (prod, preview, local
     `http://localhost:3000/api/auth/callback/google`)
2. Add `GOOGLE_ID` and `GOOGLE_SECRET` to every environment's secret
   store (Vercel for prod/preview, `.env.local` for local).
3. Smoke test in each environment after deploy: open sign-in modal,
   pick Google, complete OAuth, land on `/briefing`, verify the
   `accounts` row exists with `provider = 'google'` and that
   `access_token` is encrypted (starts with the envelope prefix from
   `account-encryption.ts`).

## Risks

- **Provider-scoped account orphan**: if a user signs in with Google for
  the first time but the allowlist rejects them, Auth.js's default
  behavior is to NOT create the user row (because `signInCallback`
  returns a redirect string before adapter `createUser` runs). Verify
  this by reading the callback. Risk is low — same path as GitHub today.
- **Browser autofill quirks**: some users have multiple Google accounts
  and may pick the wrong one in the chooser. No mitigation — this is
  normal OAuth UX everyone is used to.
- **`allowDangerousEmailAccountLinking` warning in Auth.js logs**: Auth.js
  emits a warning at startup when this flag is set. Document the rationale
  in a code comment on the providers so future grep-readers don't think
  it's unintentional.
