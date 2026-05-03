# Design Partner Allowlist + Admin Dashboard

**Date:** 2026-05-03
**Branch target:** dev
**Status:** Awaiting confirmation

## Overview

Restrict ShipFlare sign-up to an invite-only allowlist enforced in the NextAuth `signIn` callback, backed by an `allowed_emails` table. Add a single-admin dashboard at `/admin/invites` (gated by `SUPER_ADMIN_EMAIL`) for adding, revoking, and monitoring design partners. Phase 3 layers per-partner activity counts and an editable note onto the same table.

No new auth provider — keep GitHub OAuth, gate on the verified email it returns.

---

## Codebase Audit — answers to the open questions

### Migrations

- Schema files: `src/lib/db/schema/*.ts`, barrel-exported through `src/lib/db/schema/index.ts`.
- Drizzle config: `drizzle.config.ts` (out dir `./drizzle`).
- Generated SQL lives under `drizzle/` with sequential names (currently up to `0014_stiff_phil_sheldon.sql`); journal at `drizzle/meta/_journal.json`.
- Workflow: `pnpm db:generate` → emit SQL from schema deltas, `pnpm db:migrate` (`bun run scripts/run-migrations.ts`) to apply. Commit both schema TS and generated SQL.

### Last-login tracking — does NOT exist today

- `users` has only `createdAt`. No `lastLoginAt` / `updatedAt`.
- `sessions.expires` is a poor proxy.
- **Decision:** add `users.lastLoginAt timestamp` and stamp it inside the existing `signIn` callback (already fires on every successful login).

### Admin route group / auth-protected layout pattern

- `src/app/(app)/layout.tsx` calls `auth()` but delegates redirect logic to pages.
- **No existing admin route group** — create `src/app/(admin)/` as a sibling of `(app)`, with its own minimal layout.
- For "not allowed" responses, use `notFound()` from `next/navigation` (returns 404 — does not reveal page existence).

### Activity tables for Phase 3

- **Posts** → `posts` table (`src/lib/db/schema/drafts.ts:84`). `WHERE userId = $1 AND postedAt >= now() - interval '7 days'`.
- **Replies** → `posts` JOIN `drafts` ON `posts.draftId = drafts.id` WHERE `drafts.draftType = 'reply'`. The "actually shipped" signal.
- **Scans** → `activity_events` table (`src/lib/db/schema/drafts.ts:137`); exact `eventType` strings (`scan_started` / `discovery_run` / etc.) need a 5-min post-deploy spike to confirm. Render `—` not `0` while unconfirmed.

### "View as user" — cut from MVP

Real impersonation requires shadow sessions + audit logging + banner UI. Not worth it for ~5-20 partners. **Substitute:** "Copy debug bundle" button → modal of partner's recent posts/drafts/config as JSON (read-only, server-rendered, no encrypted token columns).

### Test patterns

- Vitest, `__tests__` co-located next to module. Reference: `src/lib/auth/__tests__/account-encryption.test.ts`.
- `vitest.integration.config.ts` for DB-touching tests (`pnpm test:integration`).
- E2E under `e2e/`, `pnpm test:e2e`.

---

## Schema Diff

### New table — `allowed_emails`

```ts
// src/lib/db/schema/allowed-emails.ts
export const allowedEmails = pgTable(
  'allowed_emails',
  {
    email: text('email').primaryKey(), // lowercased at write-time
    invitedAt: timestamp('invited_at', { mode: 'date' }).defaultNow().notNull(),
    invitedBy: text('invited_by').notNull(),
    note: text('note'),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
  },
  (t) => [
    index('allowed_emails_revoked_idx').on(t.revokedAt),
  ],
);
```

### Modified table — `users`

```ts
lastLoginAt: timestamp('last_login_at', { mode: 'date' }),
```

### Schema barrel

`src/lib/db/schema/index.ts` adds `export { allowedEmails } from './allowed-emails';`.

---

## Phase 1 — Allowlist gate (~1 hour, MVP)

| # | File | Change | Risk |
|---|---|---|---|
| 1.1 | `src/lib/db/schema/allowed-emails.ts` (new) | Create table per diff | Medium (email normalization) |
| 1.2 | `src/lib/db/schema/users.ts` | Add `lastLoginAt` (nullable) | Low |
| 1.3 | `src/lib/db/schema/index.ts` | Add `allowedEmails` re-export | None |
| 1.4 | `drizzle/00XX_*.sql` (generated) | `pnpm db:generate` then `pnpm db:migrate` | Low |
| 1.5 | `scripts/seed-allowed-emails.ts` (new) | Idempotent seed: `SUPER_ADMIN_EMAIL` + CLI args. `ON CONFLICT DO NOTHING` | Low |
| 1.6 | `src/lib/auth/allowlist.ts` (new) | `normalizeEmail` (`.trim().toLowerCase()`) + `isEmailAllowed(email)` returning true if `=== SUPER_ADMIN_EMAIL` OR exists with `revokedAt IS NULL`. Missing env var → log WARN, return false (don't throw) | Low |
| 1.7 | `src/lib/auth/index.ts:51-63` | Inject gate at top of `signIn` callback. `return false` if not allowed. Stamp `lastLoginAt = now()` alongside existing `githubId` write | **High — bug locks everyone out** |
| 1.8 | `src/app/page.tsx` + `src/components/marketing/hero-demo.tsx` | Read `searchParams.error === 'AccessDenied'`, render "ShipFlare is invite-only" banner | Low |
| 1.9 | `src/lib/auth/__tests__/allowlist.test.ts` (new) | Unit + integration coverage. **Must include**: super-admin allowed when table empty, super-admin allowed even if explicitly revoked (bug guard) | — |

**Phase 1 complexity: Low–Medium.** ~150 LOC new, ~20 LOC modified.

---

## Phase 2 — Admin dashboard MVP (~1 hour)

| # | File | Change | Risk |
|---|---|---|---|
| 2.1 | `src/lib/auth/admin.ts` (new) | `requireAdmin()` chokepoint: calls `auth()`, returns `{ email }` on match, calls `notFound()` otherwise | Medium |
| 2.2 | `src/app/(admin)/layout.tsx` + `src/app/(admin)/admin/invites/page.tsx` (new) | Bare layout (no AppShell), gated by `requireAdmin()`. Page = server component, `LEFT JOIN` `users ON lower(users.email) = allowed_emails.email`. Columns: email, note, invitedAt, lastLoginAt, hasRegistered, status | Low |
| 2.3 | `src/app/(admin)/admin/invites/actions.ts` (new) | Server actions: `addInvite` (Zod validate, normalize, `ON CONFLICT DO UPDATE SET revoked_at = NULL` to un-revoke), `revokeInvite` (set `revokedAt = now()`, **refuse** if email = `SUPER_ADMIN_EMAIL`), `updateNote` (≤500 chars). Each action calls `requireAdmin()` first | Medium — skipped guard = anyone grants self access |
| 2.4 | `src/app/(admin)/admin/invites/_components/invite-form.tsx` (new) | Client form bound to `addInvite` | Low |
| 2.5 | `src/app/(admin)/admin/invites/_components/revoke-button.tsx` (new) | `<form action={revokeInvite}>` per row, no JS required | Low |
| 2.6 | Tests | `admin.test.ts` (chokepoint), `actions.test.ts` (each action × admin-guard path × refuse-revoke-super-admin) | — |

**Phase 2 complexity: Medium.** ~300 LOC. Don't ship without `requireAdmin` tests green.

---

## Phase 3 — Partner health panel (~1 hour, recommended)

| # | File | Change | Risk |
|---|---|---|---|
| 3.1 | `src/lib/admin/partner-activity.ts` (new) | `getPartnerActivityCounts(userIds[])` — three batched queries (posts, replies, scans), `Promise.all`, `GROUP BY user_id` | Medium (scan event-type strings need confirmation) |
| 3.2 | `src/app/(admin)/admin/invites/page.tsx` | Three additional columns: `Posts 7d`, `Replies 7d`, `Scans 7d`. Render `—` if zero/unknown | Low |
| 3.3 | `src/app/(admin)/admin/invites/_components/note-cell.tsx` (new) | Click-to-edit textarea bound to `updateNote` action | Low |
| 3.4 | "Copy debug bundle" button (recommended substitute for "view as user") | Modal with last 20 posts/drafts/product config JSON. Projection-select only — NO encrypted token columns | Low |
| 3.5 | Tests | `partner-activity.test.ts` (integration), `note-cell.test.tsx` (component) | — |

**Phase 3 complexity: Medium.** Cut 3.4 unless an actual debugging case appears in week 1 (YAGNI).

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `SUPER_ADMIN_EMAIL` missing/typo → founder locked out | Medium | **Critical** | Startup-time WARN log if unset; seed script also writes founder to `allowed_emails` (two paths); document env var in README |
| Email case mismatch | High | High | `normalizeEmail` at every boundary (write + read). Inserts go through actions that normalize, never raw SQL |
| Race: invite added as user clicks Sign in | Low | Low | Acceptable — partner retries |
| Revocation doesn't kick out active sessions | Medium | Low | See Decision #2 |
| Admin page accidentally exposed | Low | **Critical** | `requireAdmin()` is the SOLE access path. Test 404 behavior |
| GitHub returns no email (privacy setting) | Low | Medium | Reject sign-in with friendly "GitHub didn't share your email" message |
| Phase 3 scan count = 0 from wrong eventType strings | Medium | Low | Render `—` not `0` until confirmed; spike post-deploy |
| Auth.js v5 creates `users` row before `signIn` returns false → orphan rows | Medium | Medium | **Verify empirically.** If true, add cleanup in callback OR accept harmless orphans; document |

---

## Decisions the User Still Needs to Make

1. **Email case-sensitivity** — recommend lowercase + trim everywhere.
2. **Revocation behavior** — recommend **Option B (immediate kickout)**: also `DELETE FROM sessions WHERE userId = (SELECT id FROM users WHERE lower(email) = $email)` in `revokeInvite`. ~5 extra LOC. Otherwise revocation feels broken.
3. **"Request invite" form vs. static email** — recommend **static email link** ("email founder@…"). Promote to a form only if inbound interest materializes.
4. **Admin URL** — recommend **`/admin/invites`** as-is. `notFound()` already hides it. Obscure paths are security-by-obscurity.
5. **Orphan `users` rows from rejected sign-ins** — verify Auth.js v5 behavior first; recommend delete-in-callback if the issue exists.
6. **Phase 3 scope** — recommend ship 3.1+3.2+3.3, defer 3.4.

---

## Test Strategy

| Layer | Files | Coverage target |
|---|---|---|
| Unit — pure helpers | `allowlist.test.ts`, `admin.test.ts` | 100% (small surface) |
| Integration — DB + auth callback | signIn callback test (DB seeded) | 4 cases: allowed, revoked, missing, super-admin |
| Integration — server actions | `actions.test.ts` | Each action × admin-guard path |
| E2E (optional) | `admin-invites.spec.ts`, `allowlist.spec.ts` | Add → list → revoke; rejection bounce |

Build gate: `pnpm tsc --noEmit` exit 0 (per the user's MEMORY note that `tsc` is the truth, not vitest).

---

## Success Criteria

- [ ] Non-allowlisted GitHub email → bounce to `/?error=AccessDenied` with friendly banner
- [ ] Founder (matching `SUPER_ADMIN_EMAIL`) can sign in even with empty `allowed_emails` table
- [ ] Allowlisted email → normal sign-in flow
- [ ] `/admin/invites` returns 404 for non-admins (test-verified)
- [ ] Admin can add an invite, see it in the list, partner can sign in
- [ ] Admin can revoke an invite; partner is bounced on next request (Option B)
- [ ] Phase 3: per-partner counts render with reasonable values
- [ ] All tests pass (`pnpm test` + `pnpm test:integration`)
- [ ] `pnpm tsc --noEmit` exit 0
- [ ] No new `console.log` (use `createLogger('auth:allowlist')`)

---

## Relevant File Paths

- [src/lib/auth/index.ts:51-63](../../../src/lib/auth/index.ts#L51-L63) — `signIn` callback gate-injection point
- [src/lib/db/schema/users.ts](../../../src/lib/db/schema/users.ts) — adds `lastLoginAt`
- [src/lib/db/schema/index.ts](../../../src/lib/db/schema/index.ts) — barrel export
- [src/lib/db/schema/drafts.ts](../../../src/lib/db/schema/drafts.ts) — Phase 3 source tables (`posts`, `drafts`, `activityEvents`)
- [drizzle.config.ts](../../../drizzle.config.ts) + [scripts/run-migrations.ts](../../../scripts/run-migrations.ts) — migration tooling
- [src/app/(app)/layout.tsx](../../../src/app/(app)/layout.tsx) — `(admin)` layout pattern reference
- [src/app/actions/auth.ts](../../../src/app/actions/auth.ts) — server-action pattern reference
- [src/app/page.tsx](../../../src/app/page.tsx) + [src/components/marketing/hero-demo.tsx](../../../src/components/marketing/hero-demo.tsx) — landing-page entry points for AccessDenied banner
- [src/lib/auth/__tests__/account-encryption.test.ts](../../../src/lib/auth/__tests__/account-encryption.test.ts) — test-style reference
