# Alpha Gate, Waitlist, and Admin Analytics — Design Spec

**Date:** 2026-05-11
**Status:** Approved for planning
**Author:** brainstormed with user via /brainstorming

## Problem

ShipFlare is going into alpha. The previous email allowlist was removed in commit
`704b019` (open signup) and needs to come back, but with a smoother UX for the
people who *aren't* invited — they should land somewhere that captures their
interest, not bounce off an error banner. Separately, the founder needs visibility
into how the alpha cohort is using the product (retention, funnel, daily activity)
to steer invitations and roadmap.

This spec covers three coordinated pieces that ship as one bundle:

1. **Allowlist gate** — re-enable the `signIn` callback check
2. **Waitlist** — `/waitlist` page + admin processing + email notifications
3. **Admin analytics** — `/admin/analytics` with retention, funnel, and per-user view

The allowlist infrastructure (table, admin UI, seed script, helper functions) is
still in the codebase from commit `02be710`. This spec restores the gate and
extends with the new pieces.

## Goals & non-goals

**Goals**
- Allowlisted users sign in with the existing `SignInModal` → GitHub OAuth → land
  on `/today`. Zero new clicks, zero new screens. Smooth.
- Non-allowlisted users — whether they attempt sign-in OR click "Request access" on
  landing — flow to `/waitlist`, can submit email + use-case, and the founder
  gets an email notification.
- Founder can promote a waitlist signup to the allowlist in one click from
  `/admin/invites`. The promoted user can sign in immediately afterward.
- Founder has a `/admin/analytics` dashboard showing weekly cohort retention,
  the alpha funnel (waitlist → first post), and daily activity — all queried
  from existing tables, no new tracking infra.

**Non-goals**
- Client-side analytics provider (PostHog/Plausible/etc.). Deferred — current
  goal is steering the alpha from data we already collect server-side.
- Multi-admin invite workflow. `requireAdmin()` already gates everything; we
  don't need teams of admins for alpha.
- Date-picker UI on analytics. Fixed 30-day window for v1.
- Self-serve "rejoin waitlist" / "I'm no longer interested" — users either get
  approved and sign in, or stay in pending. Dismissals are admin-only.

## Architecture

```
                        Public
       ┌──────────────────────────────────────┐
       │  /                                   │
       │   - Hero CTA "Request alpha access"  │──┐
       │   - Small "Already invited? Sign in" │  │
       └──────────────────────────────────────┘  │
                            │                    │
              "Continue with GitHub"             │
                            ▼                    ▼
              ┌─────────────────────┐    /waitlist?from=landing
              │ GitHub OAuth        │           │
              └─────────────────────┘           │
                            │                   │
                            ▼                   │
              ┌─────────────────────┐           │
              │ NextAuth signIn cb  │           │
              │   isEmailAllowed?   │           │
              └─────────────────────┘           │
                  ✓ yes      ✗ no               │
                    │           │               │
                    ▼           ▼               ▼
                /today    /waitlist?from=denied&email=...
                              │
                              ▼
                ┌──────────────────────────────┐
                │ /waitlist                    │
                │  - Form: email + use-case    │
                │  - Honeypot, rate limit      │
                │  - Pre-fills from ?email     │
                └──────────────────────────────┘
                              │  submit
                              ▼
                ┌──────────────────────────────┐
                │ waitlist_signups (INSERT)    │
                │     ↓                        │
                │ sendEmail(admin notif)       │
                └──────────────────────────────┘

                        Admin (requireAdmin)
       ┌──────────────────────────────────────────────────┐
       │ /admin/invites?tab=waitlist                      │
       │   pending rows → Approve / Dismiss               │
       │   Approve = INSERT allowed_emails (un-revoke) +  │
       │             UPDATE waitlist_signups.approvedAt + │
       │             sendEmail(approved)                  │
       └──────────────────────────────────────────────────┘

       ┌──────────────────────────────────────────────────┐
       │ /admin/analytics                                 │
       │   A. Funnel (5 bars)                             │
       │   D. Retention (cohort table + D1/D7/D14 + DAU/WAU) │
       │   B. Daily sparklines (6)                        │
       │   C. Per-user table                              │
       └──────────────────────────────────────────────────┘
```

## Section 1 — Allowlist gate

### Restore the signIn check

Recover the gate from commit `02be710` and put it back in
`src/lib/auth/index.ts`. The helper `src/lib/auth/allowlist.ts` already exists
and is untouched; restore the call site.

**Behavior:**
- Email normalized via existing `normalizeEmail()` helper
- `SUPER_ADMIN_EMAIL` bypass (anti-lockout safety net)
- Reject if email not in `allowed_emails` OR `revokedAt IS NOT NULL`
- On reject, **return a redirect URL string** (Auth.js v5 honors this):
  - Standard reject: `/waitlist?from=denied&email=<encoded>`
  - No email from GitHub (privacy): `/waitlist?from=denied&reason=no-email`
- On accept, stamp `users.lastLoginAt` and `users.githubId` exactly as before

### Delete dead access-denied banner

Rejected users now redirect to `/waitlist`, so `/?error=AccessDenied` is no
longer reachable. Delete:
- `src/components/marketing/access-denied-banner.tsx`
- The `AccessDeniedBanner` import + render + `searchParams.error` plumbing
  in `src/app/page.tsx`

## Section 2 — Waitlist data model

New Drizzle schema file `src/lib/db/schema/waitlist-signups.ts`:

```ts
export const waitlistSignups = pgTable(
  'waitlist_signups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: citext('email').notNull().unique(),          // case-insensitive
    useCase: text('use_case'),                          // nullable, 500 char max enforced at action
    referer: text('referer'),                           // 'denied' | 'landing' | 'no-email' | null
    ipHash: text('ip_hash'),                            // sha256(ip + IP_HASH_SALT), nullable
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedBy: text('dismissed_by'),
  },
  (t) => [
    index('waitlist_pending_idx').on(t.approvedAt, t.dismissedAt),
  ],
);

export type WaitlistSignup = typeof waitlistSignups.$inferSelect;
export type NewWaitlistSignup = typeof waitlistSignups.$inferInsert;
```

Registered in `src/lib/db/schema/index.ts`. Single Drizzle migration generated
via `pnpm drizzle-kit generate` (next migration number after current latest).
Migration must `CREATE EXTENSION IF NOT EXISTS citext` (if not already enabled
by an earlier migration — verify during plan).

## Section 3 — Waitlist page (`/waitlist`)

**Route:** `src/app/waitlist/page.tsx` — top-level, NOT inside `(app)` group, so
no auth required.

**File tree:**
```
src/app/waitlist/
  page.tsx
  _components/
    waitlist-form.tsx        ← client component
    context-banner.tsx       ← server component, copy varies by referer
  actions.ts                 ← 'use server' joinWaitlist
```

**`page.tsx` (server component):**
- `auth()` check → if signed in, `redirect('/today')`
- Parse `searchParams`: `from`, `email`, `reason`
- Pre-fill email only if Zod email-format check passes (XSS guard)
- Determine banner variant: `denied | no-email | landing`
- Render `<GlassNav isAuthenticated={false} />`, banner, form, `<FooterStrip />`

**Banner copy:**
| variant | headline | sub |
|---|---|---|
| denied | "Your GitHub email isn't on the alpha list yet." | "Drop your details — we'll get back to you when a slot opens." |
| no-email | "GitHub didn't share your email." | "Enter it below and we'll add you to the waitlist." |
| landing | "ShipFlare is in private alpha." | "Request access — we're inviting design partners in waves." |

**`waitlist-form.tsx` (client component):**
- Two visible fields: email (required, type=email) + use-case textarea (optional,
  maxLength 500, placeholder "What would you use ShipFlare for? Optional.")
- One hidden honeypot field: `<input name="company" tabIndex={-1} aria-hidden
  style={{position:'absolute',left:'-9999px'}}>`
- Uses `useFormState` + `useFormStatus` for pending/error display
- Success state replaces form with a thank-you card showing the email and a
  "Back to home" link. Same success state whether row is new or already existed
  (no enumeration leak).

## Section 4 — `joinWaitlist` server action

`src/app/waitlist/actions.ts`:

```ts
'use server';

const schema = z.object({
  email: z.string().email().max(254).transform((v) => v.trim().toLowerCase()),
  useCase: z.string().max(500).optional().transform((v) => v?.trim() || null),
  referer: z.enum(['denied', 'landing', 'no-email']).optional(),
  company: z.string().optional(),                  // honeypot
});

export type JoinWaitlistState = { ok: boolean; error?: string; alreadyOnList?: boolean };

export async function joinWaitlist(
  _prev: JoinWaitlistState,
  formData: FormData,
): Promise<JoinWaitlistState> {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: 'Invalid input' };
  // Honeypot tripped: return success silently
  if (parsed.data.company) return { ok: true, alreadyOnList: false };

  const ip = headers().get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await checkRateLimit({ key: `waitlist:${ip}`, limit: 5, windowSec: 60 });
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again in a minute.' };

  const ipHash = hashIp(ip);                       // sha256(ip + IP_HASH_SALT) or null if salt missing

  const [row] = await db
    .insert(waitlistSignups)
    .values({
      email: parsed.data.email,
      useCase: parsed.data.useCase,
      referer: parsed.data.referer ?? null,
      ipHash,
    })
    .onConflictDoUpdate({
      target: waitlistSignups.email,
      set: { useCase: parsed.data.useCase, updatedAt: new Date() },
    })
    .returning({
      id: waitlistSignups.id,
      createdAt: waitlistSignups.createdAt,
      updatedAt: waitlistSignups.updatedAt,
    });

  const isNew = row.updatedAt.getTime() - row.createdAt.getTime() < 1000;
  if (isNew) {
    await sendEmail(
      waitlistAdminNotification({
        email: parsed.data.email,
        useCase: parsed.data.useCase,
        referer: parsed.data.referer ?? null,
      }),
    );
  }

  return { ok: true, alreadyOnList: !isNew };
}
```

**Rate limit helper:** check for existing `src/lib/rate-limit.ts` during planning;
if absent, add a minimal Postgres-backed counter at
`src/lib/rate-limit.ts` keyed by `(key, windowStart)`. Acceptable for alpha
traffic; can swap for Redis later.

**IP hashing helper:** `src/lib/ip-hash.ts` — `hashIp(ip): string | null`,
returns null when `IP_HASH_SALT` env var unset (logs warning once per process).

## Section 5 — Email infrastructure

`src/lib/email/index.ts` — single sanctioned entry point. Server-only module.

- `sendEmail({to, subject, html?, text, replyTo?, tags?}): Promise<{ok, id?, reason?}>`
- Never throws — returns result struct
- No-op when `RESEND_API_KEY` unset (returns `{ok: false, reason: 'not_configured'}`,
  logs warn) — keeps local dev frictionless
- Requires `EMAIL_FROM` env var (verified Resend sender, e.g.
  `alpha@mail.shipflare.app`)
- Uses official `resend` npm package (~25 KB)

**Templates** in `src/lib/email/templates/` as plain functions returning
`{ subject, html, text }` — no JSX runtime, no `@react-email/render`. Text
always required; HTML optional.

| Template | Trigger | Audience |
|---|---|---|
| `waitlist-admin-notification.ts` | New `waitlist_signups` row | `SUPER_ADMIN_EMAIL` |
| `waitlist-approved.ts` | Admin clicks Approve | The applicant |

**`waitlist-admin-notification` text body:**
```
New ShipFlare waitlist signup

From: <email>
Source: <referer or "(none)">
Use case: <useCase or "(none)">

Review: <APP_URL>/admin/invites?tab=waitlist
```

**`waitlist-approved` text body:**
```
You're in.

Your ShipFlare alpha invite is ready. Sign in with GitHub using <email>:
<APP_URL>

Reply to this email if you run into trouble.
```

Both templates have matching basic-HTML versions for deliverability.

## Section 6 — Landing page updates

Re-frame primary CTAs from "sign in" to "request access" for unauthenticated
visitors. GitHub sign-in stays available as a secondary path for already-allowlisted
users.

### `src/components/marketing/hero-demo.tsx`

Unauthenticated state primary CTA changes from "Continue with GitHub" (opening
`SignInModal`) to:
```jsx
<Link href="/waitlist" className="cta-primary">Request alpha access</Link>
<button onClick={() => setSignInOpen(true)} className="cta-small">
  Already invited? Sign in with GitHub
</button>
```

Authenticated state unchanged (`Open dashboard` → `/today`).

### `src/components/marketing/cta-section.tsx`

Same treatment — primary pill becomes "Request alpha access" linking to
`/waitlist`; "Continue with GitHub" demoted to small text link below.

### `src/components/marketing/glass-nav.tsx`

**No change.** Top-right "Sign in" link stays — small, tucked in nav, fine
for returning invitees.

### `src/components/auth/sign-in-modal.tsx`

**No change.** Modal works as-is. Allowed emails sign in; non-allowed bounce
to `/waitlist` server-side via the `signIn` callback redirect.

### `src/components/marketing/access-denied-banner.tsx`

**Delete.** No longer reachable.

## Section 7 — Admin waitlist tab

Add to existing `/admin/invites` page. Tabs rendered server-side via `?tab=` URL
param — no client JS for tab switching.

**Tab strip:** `Invites` · `Waitlist (N)` where N is the pending count
(`approved_at IS NULL AND dismissed_at IS NULL`).

**Pending table columns:** Email · Use case · Source · Submitted · Actions

**Filter chips:** `Pending (N)` · `Approved (N)` · `Dismissed (N)`. Default Pending.
URL param `?status=`.

**Server actions** in `src/app/(app)/admin/invites/actions.ts` (extend existing
file), all calling `requireAdmin()`:

- **`approveWaitlistSignup(id)`** — single transaction:
  ```sql
  INSERT INTO allowed_emails (email, invited_at, invited_by, note)
    VALUES (...)
    ON CONFLICT (email) DO UPDATE
    SET revoked_at = NULL,
        invited_by = excluded.invited_by;

  UPDATE waitlist_signups
    SET approved_at = now(), approved_by = <admin_email>
    WHERE id = $1;
  ```
  Then `sendEmail(waitlistApproved(...))` fire-and-forget (logs on failure, doesn't
  block the action's success).
  Then `revalidatePath('/admin/invites')`.

- **`dismissWaitlistSignup(id)`** — `UPDATE waitlist_signups SET dismissed_at =
  now(), dismissed_by = <admin>`. No email. Reversible from the Dismissed filter
  view.

**Empty state:** "No pending waitlist signups."

## Section 8 — Admin analytics page

**Route:** `src/app/(app)/admin/analytics/page.tsx`. Gated by existing
`requireAdmin()` chokepoint. Fixed 30-day window. `export const revalidate = 60`
for 1-minute ISR.

### Section A — Alpha funnel (top of page)

Horizontal bar chart of 5 stages over the 30-day window:

| Stage | SQL source |
|---|---|
| Waitlist signups | `count(*) from waitlist_signups where created_at >= now() - 30d` |
| Approved → allowlisted | `count(*) from waitlist_signups where approved_at >= now() - 30d` |
| Signed up (first login) | `count(*) from users where created_at >= now() - 30d` |
| Ran first scan | `count(distinct user_id) from pipeline_events where stage = 'discovered' AND created_at >= now() - 30d` |
| Published first post | `count(distinct user_id) from posts where status = 'posted' AND posted_at >= now() - 30d` |

Each bar shows count + conversion % vs. prior stage. Styled `<div>` widths,
no chart library.

### Section D — Retention (second section — most actionable for alpha)

**D1. Weekly cohort retention table.** Sign-up week × weeks-since-signup matrix.
Cell = `% of cohort who took a meaningful action that week`. "Meaningful action"
= scan (`pipeline_events.stage='discovered'`) OR draft created (`drafts.createdAt`)
OR post published (`posts.posted_at`). Up to 4 weeks visible in the 30-day window.

Implementation: one SQL query joining `users` with a CTE
`daily_user_activity AS (SELECT DISTINCT user_id, date_trunc('day', created_at)::date
AS day FROM (pipeline_events WHERE stage='discovered' UNION ALL drafts UNION ALL
(posts WHERE status='posted'))) ...`, then `count(distinct user_id)` per cohort
× week-offset.

Rendered as styled HTML table with conditional background-color shading
(darker = higher retention).

**D2. N-day retention summary.** Three big numbers:

| D1 | D7 | D14 |
| % | % | % |

"Of users who signed up ≥N days ago, what % took a meaningful action by day N?"

**D3. Stickiness.** `DAU/WAU` ratio over the window. Single prominently-displayed
number with one-line caption ("<0.2 = low engagement, 0.5+ = sticky").

### Section B — Daily sparklines (third section)

Six tiny SVG sparklines on a row, daily buckets over 30 days:

1. Waitlist signups / day
2. Sign-ins / day (`users.lastLoginAt` bucketed daily)
3. Scans / day
4. Drafts created / day
5. Posts published / day
6. Approvals / day (`waitlist_signups.approvedAt`)

Each spark: today's count · 30d total · sparkline shape. No axes, no legend.

### Section C — Per-user table (fourth section)

One row per user with activity in the last 30 days. Columns:

Email · Signed up · Last seen · Scans 7d · Drafts 7d · Posts 7d · Status

- **Status badges:** 🟢 active (meaningful action in 7d) · 🟡 dormant (signin
  but no meaningful action in 7d) · 🔴 lost (no signin in 14d).
  "Meaningful action" = same definition as in retention: scan
  (`pipeline_events.stage='discovered'`) OR draft created OR post published.
- Reuses `getPartnerActivityCounts()` helper from `/admin/invites` (already
  paginated and batched).
- Default sort by Last seen DESC. Sortable via URL params (server re-renders).

### Implementation notes

- **No charting library.** Inline SVG sparklines (`src/components/admin/sparkline.tsx`),
  styled `<div>` widths for funnel bars, HTML table with CSS gradient for cohort
  cells.
- **Query parallelism:** all aggregate queries fire via `Promise.all` (existing
  pattern in `getPartnerActivityCounts`).
- **No new tables.** Pure read views.

### File list

```
src/app/(app)/admin/analytics/
  page.tsx
  _components/
    funnel.tsx
    retention.tsx
    spark-row.tsx
    user-table.tsx
  _queries/
    funnel.ts
    retention.ts
    daily.ts
    users.ts
src/components/admin/
  sparkline.tsx
```

## Section 9 — Testing

### Unit (Vitest)

| File | Coverage |
|---|---|
| `src/lib/auth/__tests__/allowlist.test.ts` | Existing — verify still green |
| `src/lib/auth/__tests__/signin-redirect.test.ts` | NEW. Allowed→true; rejected→`/waitlist?from=denied&email=...`; no-email→`/waitlist?from=denied&reason=no-email` |
| `src/app/waitlist/__tests__/actions.test.ts` | NEW. Zod validation; honeypot silent success; rate limit; idempotent upsert; debounce notification (no double admin email) |
| `src/lib/email/__tests__/index.test.ts` | NEW. No-op without API key; surfaces failures without throwing |
| `src/lib/email/templates/__tests__/*.test.ts` | NEW. Subject + body snapshots |
| `src/app/(app)/admin/invites/__tests__/actions.test.ts` | EXTEND. `approveWaitlistSignup` (transactional); `dismissWaitlistSignup` |
| `src/app/(app)/admin/analytics/_queries/__tests__/*.test.ts` | NEW. Use `src/lib/test-utils/in-memory-db.ts`. Funnel, retention, daily, users — each with seeded fixtures and asserted result counts |

### E2E (Playwright)

`e2e/tests/alpha-gate.spec.ts`:

1. Non-allowed user → redirected to `/waitlist?from=denied&email=...` with pre-fill
2. Submit waitlist form → success card visible; DB row inserted
3. Admin logs in (SUPER_ADMIN_EMAIL), navigates to `/admin/invites?tab=waitlist`,
   clicks Approve → row appears in invites table
4. Approved user re-attempts sign-in → lands on `/today`
5. Landing CTAs "Request alpha access" link to `/waitlist`

### Real-browser smoke (per project memory)

The implementation plan must include a manual Playwright run against `pnpm dev`
covering: `/` → "Request access" → fill form → submit → DB check →
`/admin/invites?tab=waitlist` → Approve → re-attempt GitHub sign-in → land on
`/today`. User has GitHub authenticated locally so this can connect to existing
browser context.

### Coverage target

80% per project rules. Funnel/retention/daily queries covered by query-level
unit tests with seeded fixtures.

## Section 10 — Security

| Risk | Mitigation |
|---|---|
| Open form spam | Honeypot `name="company"` + IP rate limit (5/min, 20/hr) + Zod email format |
| IP storage / GDPR | `IP_HASH_SALT` hashed; raw IP never persisted |
| XSS via `?email=` pre-fill | Zod email format check before pre-fill; React auto-escapes JSX |
| Email enumeration | Identical success state for new vs. existing rows |
| Auth bypass via crafted `signIn` redirect URL | Returned URL built from helper output + DB lookup; no user-controlled string concat in the URL |
| Admin actions without admin | All Approve/Dismiss server actions call `requireAdmin()` (existing pattern) |
| Resend API key leakage | Server-only env; `src/lib/email/*` never imported in client bundles |
| Stale revocation state on Approve | `ON CONFLICT (email) DO UPDATE SET revoked_at = NULL` — re-invite always clears revocation |
| Signed-in user visits `/waitlist` | Server-side `auth()` check + `redirect('/today')` |

## Section 11 — Env vars and migration

### New env vars (all documented in `.env.example`)

| Var | Phase | Notes |
|---|---|---|
| `RESEND_API_KEY` | 2 | App boots without it — emails are no-op'd |
| `EMAIL_FROM` | 2 | Verified Resend sender domain |
| `IP_HASH_SALT` | 1 | Generate via `openssl rand -hex 32` |

### Migration

Single Drizzle migration created via `pnpm drizzle-kit generate`:
- `CREATE EXTENSION IF NOT EXISTS citext` (if not already enabled)
- `CREATE TABLE waitlist_signups (...)`
- `CREATE INDEX waitlist_pending_idx ON waitlist_signups (approved_at, dismissed_at)`

Idempotent. Does not touch existing tables.

### Pre-merge checklist

- [ ] `SUPER_ADMIN_EMAIL` set in prod (already true)
- [ ] `ADMIN_EMAILS` set in prod (already true)
- [ ] `IP_HASH_SALT` set in prod (Phase 1)
- [ ] `pnpm db:migrate` run in prod after Phase 1 merge
- [ ] `RESEND_API_KEY` set in prod (Phase 2)
- [ ] `EMAIL_FROM` set to verified Resend sender (Phase 2)
- [ ] `scripts/seed-allowed-emails.ts` run for any new alpha invitees

## Section 12 — Rollout

Two phases, each independently deployable:

1. **Phase 1 — Gate + waitlist + email infra.** Allowlist re-enabled; `/waitlist`
   page + action + DB table; admin tab on `/admin/invites`; landing CTA updates;
   `AccessDeniedBanner` deleted; `src/lib/email/*` module + both templates wired.
   Email module is a graceful no-op when `RESEND_API_KEY` unset, so the action
   compiles and runs whether or not Resend is configured.

   **Env activation:** setting `RESEND_API_KEY` + `EMAIL_FROM` in prod turns
   notifications on. Doing this AFTER Phase 1 merge is fine — no code change
   needed, just env-var flip and a restart.

2. **Phase 2 — Analytics.** `/admin/analytics` page with funnel + retention +
   daily sparks + per-user table.

**Rollback for Phase 1:** revert the `signIn` callback to the current open-signup
version. Table and admin UI stay (harmless). No data loss.

## Open questions resolved during brainstorming

- **Reject UX:** dedicated `/waitlist` page (not inline banner or modal).
- **Entry points:** anyone can hit `/waitlist`; also linked from landing as
  "Request alpha access".
- **Form fields:** email + optional use-case textarea. Pre-fill email from
  `?email=` query param.
- **Admin processing:** new tab on `/admin/invites` with 1-click Approve.
  Approve = insert into `allowed_emails` (un-revoke on conflict) +
  mark waitlist row.
- **Notifications:** email via Resend to SUPER_ADMIN_EMAIL on new signup.
  Also approval email to the applicant on Approve.
- **Analytics depth:** admin dashboard from existing DB tables. No new tracking
  infra. Funnel + retention + daily + per-user.
- **Analytics audience:** admin only (existing `requireAdmin()` gate).
- **Retention definition:** "active" = took a meaningful action that week
  (scan OR draft OR post), not mere sign-in.

## Files touched (full inventory)

**Restored/extended:**
- `src/lib/auth/index.ts` — restore `signIn` allowlist gate; switch `return false` → string redirects

**Deleted:**
- `src/components/marketing/access-denied-banner.tsx`
- `AccessDeniedBanner` references in `src/app/page.tsx`

**Modified:**
- `src/app/page.tsx` — drop `AccessDeniedBanner`, drop `searchParams.error` plumbing
- `src/components/marketing/hero-demo.tsx` — re-framed CTAs
- `src/components/marketing/cta-section.tsx` — re-framed CTAs
- `src/app/(app)/admin/invites/page.tsx` — tabs, waitlist table
- `src/app/(app)/admin/invites/actions.ts` — add `approveWaitlistSignup`, `dismissWaitlistSignup`
- `src/lib/db/schema/index.ts` — register `waitlistSignups`
- `.env.example` — three new vars

**New:**
- `src/lib/db/schema/waitlist-signups.ts`
- `src/lib/db/migrations/<next-number>_waitlist_signups.sql` (generated)
- `src/app/waitlist/page.tsx`
- `src/app/waitlist/_components/waitlist-form.tsx`
- `src/app/waitlist/_components/context-banner.tsx`
- `src/app/waitlist/actions.ts`
- `src/lib/email/index.ts`
- `src/lib/email/templates/waitlist-admin-notification.ts`
- `src/lib/email/templates/waitlist-approved.ts`
- `src/lib/rate-limit.ts` (if not already present)
- `src/lib/ip-hash.ts`
- `src/app/(app)/admin/analytics/page.tsx`
- `src/app/(app)/admin/analytics/_components/funnel.tsx`
- `src/app/(app)/admin/analytics/_components/retention.tsx`
- `src/app/(app)/admin/analytics/_components/spark-row.tsx`
- `src/app/(app)/admin/analytics/_components/user-table.tsx`
- `src/app/(app)/admin/analytics/_queries/funnel.ts`
- `src/app/(app)/admin/analytics/_queries/retention.ts`
- `src/app/(app)/admin/analytics/_queries/daily.ts`
- `src/app/(app)/admin/analytics/_queries/users.ts`
- `src/components/admin/sparkline.tsx`
- Tests as listed in Section 9
