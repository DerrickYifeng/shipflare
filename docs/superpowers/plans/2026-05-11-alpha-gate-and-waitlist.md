# Alpha Gate, Waitlist, and Admin Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [docs/superpowers/specs/2026-05-11-alpha-gate-and-waitlist-design.md](../specs/2026-05-11-alpha-gate-and-waitlist-design.md)

**Goal:** Re-enable the email allowlist gate, capture non-invited users on a `/waitlist` page that admins can promote in one click, send Resend-backed admin/applicant emails, and surface alpha health on `/admin/analytics` (funnel + weekly cohort retention + daily activity + per-user table).

**Architecture:** Single-bundle change. The gate is restored from commit `02be710` (helper module `src/lib/auth/allowlist.ts` is still present); rejection now returns a string from the `signIn` callback (Auth.js v5 interprets as a redirect URL → `/waitlist`). Waitlist storage is a new `waitlist_signups` table; the admin tab on `/admin/invites` writes through to the existing `allowed_emails` table on Approve. Email is centralized in `src/lib/email/*` and gracefully no-ops without `RESEND_API_KEY` so the action compiles regardless of env. Analytics reads from existing tables only — no new tracking infra.

**Tech Stack:** Next.js 15 (App Router, server components + server actions) · Auth.js v5 · Drizzle ORM · Postgres (`citext` extension) · Redis (via existing `acquireRateLimit`) · Resend (new dep) · Vitest · Playwright.

**Two phases.** Each independently shippable.

- **Phase 1** (Tasks 1–12): gate + waitlist + email infra + admin tab + landing reframe + E2E.
- **Phase 2** (Tasks 13–18): admin analytics page (funnel, retention, daily, per-user).

---

## File Inventory

### Phase 1 — New files
- `src/lib/db/schema/waitlist-signups.ts` — Drizzle schema
- `drizzle/0027_waitlist_signups.sql` — generated migration
- `src/lib/ip-hash.ts` — `hashIp(ip): string | null`
- `src/lib/__tests__/ip-hash.test.ts`
- `src/lib/email/index.ts` — `sendEmail()` entry point
- `src/lib/email/__tests__/index.test.ts`
- `src/lib/email/templates/waitlist-admin-notification.ts`
- `src/lib/email/templates/waitlist-approved.ts`
- `src/lib/email/templates/__tests__/waitlist-admin-notification.test.ts`
- `src/lib/email/templates/__tests__/waitlist-approved.test.ts`
- `src/lib/auth/__tests__/signin-redirect.test.ts`
- `src/app/waitlist/page.tsx`
- `src/app/waitlist/actions.ts`
- `src/app/waitlist/_components/waitlist-form.tsx`
- `src/app/waitlist/_components/context-banner.tsx`
- `src/app/waitlist/__tests__/actions.test.ts`
- `src/app/(app)/admin/invites/_components/waitlist-tab.tsx`
- `src/app/(app)/admin/invites/_components/waitlist-actions-buttons.tsx`
- `e2e/tests/alpha-gate.spec.ts`

### Phase 1 — Modified files
- `src/lib/auth/index.ts` — restore `signIn` gate; return redirect URL on reject
- `src/lib/db/schema/index.ts` — export `waitlistSignups`
- `src/app/page.tsx` — remove `AccessDeniedBanner` + `searchParams.error` plumbing
- `src/components/marketing/hero-demo.tsx` — primary CTA → `/waitlist`
- `src/components/marketing/cta-section.tsx` — primary CTA → `/waitlist`
- `src/app/(app)/admin/invites/page.tsx` — tabbed: invites + waitlist
- `src/app/(app)/admin/invites/actions.ts` — add `approveWaitlistSignup`, `dismissWaitlistSignup`
- `src/app/(app)/admin/invites/__tests__/actions.test.ts` — extend with new action tests
- `.env.example` — add `RESEND_API_KEY`, `EMAIL_FROM`, `IP_HASH_SALT`
- `package.json` — add `resend` dependency

### Phase 1 — Deleted files
- `src/components/marketing/access-denied-banner.tsx`

### Phase 2 — New files
- `src/components/admin/sparkline.tsx`
- `src/components/admin/__tests__/sparkline.test.tsx`
- `src/app/(app)/admin/analytics/page.tsx`
- `src/app/(app)/admin/analytics/_components/funnel.tsx`
- `src/app/(app)/admin/analytics/_components/retention.tsx`
- `src/app/(app)/admin/analytics/_components/spark-row.tsx`
- `src/app/(app)/admin/analytics/_components/user-table.tsx`
- `src/app/(app)/admin/analytics/_queries/funnel.ts`
- `src/app/(app)/admin/analytics/_queries/retention.ts`
- `src/app/(app)/admin/analytics/_queries/daily.ts`
- `src/app/(app)/admin/analytics/_queries/users.ts`
- `src/app/(app)/admin/analytics/_queries/__tests__/funnel.test.ts`
- `src/app/(app)/admin/analytics/_queries/__tests__/retention.test.ts`
- `src/app/(app)/admin/analytics/_queries/__tests__/daily.test.ts`
- `src/app/(app)/admin/analytics/_queries/__tests__/users.test.ts`

### Phase 2 — Modified files
- `src/app/(app)/admin/page.tsx` — add link to `/admin/analytics`

---

# Phase 1

## Task 1: Schema, migration, and DB plumbing for `waitlist_signups`

**Files:**
- Create: `src/lib/db/schema/waitlist-signups.ts`
- Create: `drizzle/0027_waitlist_signups.sql` (generated)
- Modify: `src/lib/db/schema/index.ts`

- [ ] **Step 1: Verify `citext` extension status**

Run:
```bash
grep -rE "CREATE EXTENSION.*citext" drizzle/*.sql
```

If found → extension is already enabled. If not, the generated migration must include `CREATE EXTENSION IF NOT EXISTS citext;` (Step 4 below).

- [ ] **Step 2: Write schema file**

Create `src/lib/db/schema/waitlist-signups.ts`:

```ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// citext — case-insensitive text — for emails. Drizzle has no native
// citext, so we declare it as a customType backed by the Postgres type.
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

export const waitlistSignups = pgTable(
  'waitlist_signups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: citext('email').notNull().unique(),
    useCase: text('use_case'),
    referer: text('referer'), // 'denied' | 'landing' | 'no-email' | null
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedBy: text('dismissed_by'),
  },
  (t) => [index('waitlist_pending_idx').on(t.approvedAt, t.dismissedAt)],
);

export type WaitlistSignup = typeof waitlistSignups.$inferSelect;
export type NewWaitlistSignup = typeof waitlistSignups.$inferInsert;
```

- [ ] **Step 3: Register in schema barrel**

Modify `src/lib/db/schema/index.ts`. Find the existing export list and add:

```ts
export {
  waitlistSignups,
  type WaitlistSignup,
  type NewWaitlistSignup,
} from './waitlist-signups';
```

If the barrel uses `export *` for tables, just add `export * from './waitlist-signups';` instead, matching the surrounding style.

- [ ] **Step 4: Generate the migration**

Run:
```bash
pnpm drizzle-kit generate
```

This produces `drizzle/0027_waitlist_signups.sql` (or whatever the next number is — verify it lands in `drizzle/`). Open it and verify it contains:
- `CREATE EXTENSION IF NOT EXISTS citext;` (only if not previously enabled; if Step 1 found it already enabled, this line should NOT be there — Drizzle won't add it on its own, so add manually at top if needed)
- `CREATE TABLE "waitlist_signups" (...)` with all columns
- `CREATE UNIQUE INDEX ... ON "waitlist_signups" ("email")`
- `CREATE INDEX "waitlist_pending_idx" ON "waitlist_signups" ("approved_at","dismissed_at")`

If `citext` isn't already enabled and Drizzle didn't add the `CREATE EXTENSION` line, manually prepend to the migration:
```sql
CREATE EXTENSION IF NOT EXISTS citext;
```

- [ ] **Step 5: Apply the migration locally and verify**

Run:
```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "\d waitlist_signups"
```

Expected: table exists with all columns, unique constraint on `email`, partial index `waitlist_pending_idx`.

Also verify type round-trip:
```bash
pnpm tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema/waitlist-signups.ts \
        src/lib/db/schema/index.ts \
        drizzle/0027_waitlist_signups.sql \
        drizzle/meta/
git commit -m "feat(db): add waitlist_signups table

Stores public waitlist submissions (email + use case) with admin
approve/dismiss tracking. Email is citext + unique to allow idempotent
upserts. Partial index on (approved_at, dismissed_at) accelerates the
'pending' admin view."
```

---

## Task 2: IP hash helper + tests

**Files:**
- Create: `src/lib/ip-hash.ts`
- Create: `src/lib/__tests__/ip-hash.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/ip-hash.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hashIp } from '../ip-hash';

describe('hashIp', () => {
  const ORIGINAL_SALT = process.env.IP_HASH_SALT;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.IP_HASH_SALT = 'test-salt-deterministic';
  });

  afterEach(() => {
    process.env.IP_HASH_SALT = ORIGINAL_SALT;
  });

  it('returns a hex string of length 64 (sha256) for a normal IP', () => {
    const result = hashIp('203.0.113.42');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input + salt → same output', () => {
    expect(hashIp('203.0.113.42')).toBe(hashIp('203.0.113.42'));
  });

  it('differs when salt differs', () => {
    const a = hashIp('203.0.113.42');
    process.env.IP_HASH_SALT = 'different-salt';
    const b = hashIp('203.0.113.42');
    expect(a).not.toBe(b);
  });

  it('returns null and warns when IP_HASH_SALT is missing', () => {
    delete process.env.IP_HASH_SALT;
    expect(hashIp('203.0.113.42')).toBeNull();
  });

  it('returns null when IP is "unknown" sentinel', () => {
    expect(hashIp('unknown')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run src/lib/__tests__/ip-hash.test.ts
```

Expected: FAIL with "Cannot find module '../ip-hash'" or similar.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ip-hash.ts`:

```ts
import { createHash } from 'node:crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:ip-hash');
let saltWarnLogged = false;

/**
 * SHA-256 hash an IP with the server-side `IP_HASH_SALT` so we can detect
 * "same source resubmitted" without storing raw IPs. Returns null when:
 *   - `IP_HASH_SALT` env var is unset (logs warn once per process)
 *   - the IP is the "unknown" sentinel (callers pass this when
 *     x-forwarded-for is missing)
 *
 * Generate the salt once per environment:
 *   openssl rand -hex 32
 */
export function hashIp(ip: string): string | null {
  if (!ip || ip === 'unknown') return null;

  const salt = process.env.IP_HASH_SALT;
  if (!salt || salt.trim() === '') {
    if (!saltWarnLogged) {
      log.warn('IP_HASH_SALT not set — IP hashing disabled');
      saltWarnLogged = true;
    }
    return null;
  }

  return createHash('sha256').update(ip + salt).digest('hex');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm vitest run src/lib/__tests__/ip-hash.test.ts
```

Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ip-hash.ts src/lib/__tests__/ip-hash.test.ts
git commit -m "feat(lib): add hashIp helper

Sha256-hashes raw IPs with IP_HASH_SALT so we can deduplicate
waitlist submissions per source without persisting raw IPs.
Returns null and warns once when the salt isn't configured."
```

---

## Task 3: Email module — `sendEmail` with no-op fallback

**Files:**
- Create: `src/lib/email/index.ts`
- Create: `src/lib/email/__tests__/index.test.ts`
- Modify: `package.json` (add `resend` dependency)

- [ ] **Step 1: Add the Resend dependency**

Run:
```bash
pnpm add resend
```

Verify in `package.json` that `resend` is in `dependencies` (not `devDependencies`).

- [ ] **Step 2: Write the failing tests**

Create `src/lib/email/__tests__/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted Resend mock — set per-test
const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn(() => ({ emails: { send: sendMock } })),
}));

describe('sendEmail', () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;
  const ORIGINAL_FROM = process.env.EMAIL_FROM;

  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = ORIGINAL_KEY;
    process.env.EMAIL_FROM = ORIGINAL_FROM;
  });

  it('returns ok:false with reason "not_configured" when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = 'alpha@mail.test';
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns ok:false with reason "missing_from" when EMAIL_FROM is missing', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    delete process.env.EMAIL_FROM;
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: false, reason: 'missing_from' });
  });

  it('forwards the payload to Resend and returns the id on success', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'alpha@mail.test';
    sendMock.mockResolvedValueOnce({ data: { id: 'email_123' }, error: null });
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: true, id: 'email_123' });
    expect(sendMock).toHaveBeenCalledWith({
      from: 'alpha@mail.test',
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
  });

  it('returns ok:false and does not throw when Resend rejects', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'alpha@mail.test';
    sendMock.mockRejectedValueOnce(new Error('network down'));
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('network down');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
pnpm vitest run src/lib/email/__tests__/index.test.ts
```

Expected: FAIL with "Cannot find module '../index'".

- [ ] **Step 4: Write the implementation**

Create `src/lib/email/index.ts`:

```ts
import { Resend } from 'resend';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:email');

export interface EmailPayload {
  to: string | string[];
  subject: string;
  html?: string;
  text: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
}

export type SendEmailResult =
  | { ok: true; id?: string }
  | { ok: false; reason: string };

let client: Resend | null = null;
function getClient(): Resend | null {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key || key.trim() === '') return null;
  client = new Resend(key);
  return client;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/**
 * Send an email via Resend. Server-only. Never throws — returns a
 * result struct so callers can decide whether to surface or swallow.
 *
 * Gracefully no-ops (returns `{ ok: false, reason: 'not_configured' }`)
 * when `RESEND_API_KEY` is unset. This keeps local development frictionless
 * and lets the waitlist server action call `sendEmail` regardless of
 * whether prod env vars are set yet.
 *
 * `EMAIL_FROM` must be set to a verified Resend sender. If unset,
 * returns `{ ok: false, reason: 'missing_from' }`.
 */
export async function sendEmail(payload: EmailPayload): Promise<SendEmailResult> {
  const c = getClient();
  if (!c) {
    log.warn('email skipped — RESEND_API_KEY not configured', {
      to: payload.to,
      subject: payload.subject,
    });
    return { ok: false, reason: 'not_configured' };
  }
  const from = process.env.EMAIL_FROM;
  if (!from || from.trim() === '') {
    log.error('EMAIL_FROM not configured but RESEND_API_KEY is set');
    return { ok: false, reason: 'missing_from' };
  }

  try {
    const result = await c.emails.send({ from, ...payload });
    if (result.error) {
      log.error('email send failed', { error: result.error });
      return { ok: false, reason: getErrorMessage(result.error) };
    }
    return { ok: true, id: result.data?.id };
  } catch (err: unknown) {
    log.error('email send threw', err);
    return { ok: false, reason: getErrorMessage(err) };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm vitest run src/lib/email/__tests__/index.test.ts
```

Expected: 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email/ package.json pnpm-lock.yaml
git commit -m "feat(email): add Resend-backed sendEmail with no-op fallback

Single sanctioned entry point. Returns a result struct instead of
throwing. Gracefully no-ops when RESEND_API_KEY is unset so callers
compile without env vars in dev. Server-only module."
```

---

## Task 4: Email templates — admin notification + applicant approved

**Files:**
- Create: `src/lib/email/templates/waitlist-admin-notification.ts`
- Create: `src/lib/email/templates/waitlist-approved.ts`
- Create: `src/lib/email/templates/__tests__/waitlist-admin-notification.test.ts`
- Create: `src/lib/email/templates/__tests__/waitlist-approved.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/email/templates/__tests__/waitlist-admin-notification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { waitlistAdminNotification } from '../waitlist-admin-notification';

describe('waitlistAdminNotification', () => {
  it('addresses SUPER_ADMIN_EMAIL', () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@shipflare.app';
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: 'building a SaaS',
      referer: 'denied',
    });
    expect(email.to).toBe('founder@shipflare.app');
  });

  it('includes email, source, and use case in the text body', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: 'building a SaaS',
      referer: 'denied',
    });
    expect(email.text).toContain('newuser@example.com');
    expect(email.text).toContain('denied');
    expect(email.text).toContain('building a SaaS');
  });

  it('renders "(none)" for null use case', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: 'landing',
    });
    expect(email.text).toContain('Use case: (none)');
  });

  it('renders "(none)" for null referer', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: null,
    });
    expect(email.text).toContain('Source: (none)');
  });

  it('includes the admin review URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://shipflare.app';
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: null,
    });
    expect(email.text).toContain('https://shipflare.app/admin/invites?tab=waitlist');
  });

  it('subject line starts with [ShipFlare]', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: null,
    });
    expect(email.subject).toMatch(/^\[ShipFlare\]/);
  });
});
```

Create `src/lib/email/templates/__tests__/waitlist-approved.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { waitlistApproved } from '../waitlist-approved';

describe('waitlistApproved', () => {
  it('addresses the applicant', () => {
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.to).toBe('newuser@example.com');
  });

  it('includes the applicant email in the body', () => {
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.text).toContain('newuser@example.com');
  });

  it('includes the app URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://shipflare.app';
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.text).toContain('https://shipflare.app');
  });

  it('subject line is friendly and short', () => {
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.subject.length).toBeLessThan(80);
    expect(email.subject).toMatch(/alpha|invite|in/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm vitest run src/lib/email/templates/__tests__/
```

Expected: FAIL with "Cannot find module" for both files.

- [ ] **Step 3: Write the templates**

Create `src/lib/email/templates/waitlist-admin-notification.ts`:

```ts
import type { EmailPayload } from '../index';

export interface AdminNotificationInput {
  email: string;
  useCase: string | null;
  referer: string | null;
}

export function waitlistAdminNotification(
  input: AdminNotificationInput,
): EmailPayload {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL ?? '';
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://shipflare.app';
  const useCase = input.useCase ?? '(none)';
  const source = input.referer ?? '(none)';

  const text = [
    'New ShipFlare waitlist signup',
    '',
    `From: ${input.email}`,
    `Source: ${source}`,
    `Use case: ${useCase}`,
    '',
    `Review: ${appUrl}/admin/invites?tab=waitlist`,
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
  <p><strong>New ShipFlare waitlist signup</strong></p>
  <p>From: <a href="mailto:${escapeHtml(input.email)}">${escapeHtml(input.email)}</a><br>
  Source: ${escapeHtml(source)}<br>
  Use case: ${escapeHtml(useCase)}</p>
  <p><a href="${appUrl}/admin/invites?tab=waitlist">Review in admin</a></p>
</div>`;

  return {
    to: adminEmail,
    subject: `[ShipFlare] Waitlist signup: ${input.email}`,
    text,
    html,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

Create `src/lib/email/templates/waitlist-approved.ts`:

```ts
import type { EmailPayload } from '../index';

export interface ApprovedInput {
  email: string;
}

export function waitlistApproved(input: ApprovedInput): EmailPayload {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://shipflare.app';

  const text = [
    "You're in.",
    '',
    `Your ShipFlare alpha invite is ready. Sign in with GitHub using ${input.email}:`,
    appUrl,
    '',
    'Reply to this email if you run into trouble.',
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
  <p><strong>You're in.</strong></p>
  <p>Your ShipFlare alpha invite is ready. Sign in with GitHub using <code>${escapeHtml(input.email)}</code>:</p>
  <p><a href="${appUrl}">${appUrl}</a></p>
  <p>Reply to this email if you run into trouble.</p>
</div>`;

  return {
    to: input.email,
    subject: "You're in — ShipFlare alpha invite",
    text,
    html,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm vitest run src/lib/email/templates/__tests__/
```

Expected: 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/templates/
git commit -m "feat(email): add waitlist admin-notification + approved templates

Two pure functions returning EmailPayload objects. No JSX runtime,
no react-email/render dep — keeps the bundle thin. HTML escapes
user-controlled fields. Subject + text body + HTML body all included
per Resend deliverability recommendations."
```

---

## Task 5: Restore `signIn` allowlist gate with redirect URL on reject

**Files:**
- Modify: `src/lib/auth/index.ts`
- Create: `src/lib/auth/__tests__/signin-redirect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/__tests__/signin-redirect.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })) } }));
vi.mock('@/lib/auth/allowlist', () => ({
  isEmailAllowed: vi.fn(),
  normalizeEmail: (s: string) => s.trim().toLowerCase(),
  getSuperAdminEmail: () => null,
}));

import { isEmailAllowed } from '@/lib/auth/allowlist';

async function importSignInCallback() {
  // Re-import to pick up env changes
  const mod = await import('../signin-callback');
  return mod.signInCallback;
}

describe('signIn callback redirect behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true for an allowed email', async () => {
    vi.mocked(isEmailAllowed).mockResolvedValue(true);
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: 'u1', email: 'alice@example.com' },
      account: { provider: 'github' },
      profile: { id: 12345, login: 'alice' },
    });
    expect(result).toBe(true);
  });

  it('returns /waitlist redirect URL for a disallowed email', async () => {
    vi.mocked(isEmailAllowed).mockResolvedValue(false);
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: undefined, email: 'mallory@example.com' },
      account: { provider: 'github' },
      profile: { id: 67890, login: 'mallory' },
    });
    expect(result).toBe(
      '/waitlist?from=denied&email=mallory%40example.com',
    );
  });

  it('returns /waitlist redirect with reason=no-email when provider gave no email', async () => {
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: undefined, email: null },
      account: { provider: 'github' },
      profile: { id: 67890, login: 'mallory' },
    });
    expect(result).toBe('/waitlist?from=denied&reason=no-email');
  });

  it('url-encodes the email', async () => {
    vi.mocked(isEmailAllowed).mockResolvedValue(false);
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: undefined, email: 'name+tag@example.com' },
      account: { provider: 'github' },
      profile: { id: 1, login: 'x' },
    });
    expect(result).toBe(
      '/waitlist?from=denied&email=name%2Btag%40example.com',
    );
  });
});
```

To make this testable, factor the callback into a separately-exported function in a new file `src/lib/auth/signin-callback.ts`. We'll import that function into `src/lib/auth/index.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run src/lib/auth/__tests__/signin-redirect.test.ts
```

Expected: FAIL with "Cannot find module '../signin-callback'".

- [ ] **Step 3: Write the signin-callback module**

Create `src/lib/auth/signin-callback.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isEmailAllowed, normalizeEmail } from './allowlist';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth:signin');

interface SignInArgs {
  user: { id?: string; email?: string | null };
  account?: { provider?: string } | null;
  profile?: unknown;
}

/**
 * NextAuth v5 signIn callback. Returns:
 *   - `true` to allow sign-in
 *   - a URL string to redirect (Auth.js v5 interprets string returns as redirects)
 *
 * Gate logic:
 *   1. If GitHub didn't return an email → redirect to /waitlist with reason=no-email
 *   2. If email is not in `allowed_emails` (or revoked) → redirect to /waitlist with the email pre-filled
 *   3. Otherwise → stamp lastLoginAt + githubId, return true
 *
 * `SUPER_ADMIN_EMAIL` is handled inside `isEmailAllowed` as the safety net.
 */
export async function signInCallback(args: SignInArgs): Promise<true | string> {
  const rawEmail = args.user.email ?? null;
  if (!rawEmail) {
    log.warn('signIn rejected: no email returned from provider');
    return '/waitlist?from=denied&reason=no-email';
  }
  const email = normalizeEmail(rawEmail);

  if (!(await isEmailAllowed(email))) {
    log.warn(`signIn rejected: ${email} not in allowlist`);
    return `/waitlist?from=denied&email=${encodeURIComponent(email)}`;
  }

  // Gate passed — stamp metadata. Bundle githubId + lastLoginAt in
  // one UPDATE so we don't double-roundtrip the DB.
  if (args.account?.provider === 'github' && args.profile && args.user.id) {
    const githubProfile = args.profile as { id?: number; login?: string };
    await db
      .update(users)
      .set({
        ...(githubProfile.id ? { githubId: String(githubProfile.id) } : {}),
        lastLoginAt: new Date(),
      })
      .where(eq(users.id, args.user.id));
  } else if (args.user.id) {
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, args.user.id));
  }

  return true;
}
```

- [ ] **Step 4: Wire it into `src/lib/auth/index.ts`**

Open `src/lib/auth/index.ts`. Find the existing `async signIn({ user, account, profile })` callback block (currently only stamps `lastLoginAt`). Replace it entirely:

```ts
import { signInCallback } from './signin-callback';
```

(Add to imports at the top.)

Then in the `NextAuth({ callbacks: { ... } })` object, replace the existing `async signIn(...)` definition with:

```ts
signIn: signInCallback,
```

Drop any duplicated logic that the old callback was doing — `signInCallback` handles `lastLoginAt` stamping itself.

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm vitest run src/lib/auth/__tests__/signin-redirect.test.ts
pnpm vitest run src/lib/auth/__tests__/allowlist.test.ts
pnpm tsc --noEmit
```

Expected: all tests passing; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/signin-callback.ts \
        src/lib/auth/index.ts \
        src/lib/auth/__tests__/signin-redirect.test.ts
git commit -m "feat(auth): restore allowlist gate with /waitlist redirect

Reinstates the email-allowlist check that was removed in 704b019.
On reject, returns a redirect URL string (Auth.js v5 honors string
returns) routing the user to /waitlist with their GitHub email
pre-filled. GitHub privacy → no email → redirect with reason=no-email.

Callback extracted to signin-callback.ts so it's unit-testable in
isolation. Anti-lockout SUPER_ADMIN_EMAIL bypass still in
allowlist.isEmailAllowed."
```

---

## Task 6: `joinWaitlist` server action + tests

**Files:**
- Create: `src/app/waitlist/actions.ts`
- Create: `src/app/waitlist/__tests__/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/app/waitlist/__tests__/actions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const insertReturn = vi.fn();
const onConflictDoUpdate = vi.fn(() => ({ returning: insertReturn }));
const values = vi.fn(() => ({ onConflictDoUpdate }));
const insertFn = vi.fn(() => ({ values }));

vi.mock('@/lib/db', () => ({
  db: { insert: insertFn },
}));

vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, id: 'em1' }),
}));

vi.mock('@/lib/email/templates/waitlist-admin-notification', () => ({
  waitlistAdminNotification: vi.fn((i) => ({
    to: 'admin@x',
    subject: 's',
    text: `T:${i.email}`,
  })),
}));

vi.mock('@/lib/ip-hash', () => ({
  hashIp: vi.fn(() => 'abc123'),
}));

vi.mock('next/headers', () => ({
  headers: () => new Headers({ 'x-forwarded-for': '203.0.113.42' }),
}));

import { joinWaitlist } from '../actions';
import { acquireRateLimit } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email';

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const NOW = new Date('2026-05-11T00:00:00Z');

describe('joinWaitlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acquireRateLimit).mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    insertReturn.mockResolvedValue([
      { id: 'w1', createdAt: NOW, updatedAt: NOW },
    ]);
  });

  it('rejects invalid email with a friendly error', async () => {
    const result = await joinWaitlist(undefined as never, fd({ email: 'not-an-email' }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('returns success silently when honeypot is filled (no DB write, no email)', async () => {
    const result = await joinWaitlist(undefined as never, fd({
      email: 'real@example.com',
      company: 'spam-bot',
    }));
    expect(result.ok).toBe(true);
    expect(insertFn).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns rate-limit error when acquireRateLimit denies', async () => {
    vi.mocked(acquireRateLimit).mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 30,
    });
    const result = await joinWaitlist(undefined as never, fd({ email: 'a@b.com' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too many/i);
  });

  it('upserts a new row and sends admin notification', async () => {
    await joinWaitlist(undefined as never, fd({
      email: 'NewUser@Example.COM',
      useCase: '  building a SaaS  ',
      referer: 'landing',
    }));

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      email: 'newuser@example.com',         // normalized
      useCase: 'building a SaaS',           // trimmed
      referer: 'landing',
      ipHash: 'abc123',
    }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips admin notification when the row already existed', async () => {
    const past = new Date(NOW.getTime() - 10 * 60 * 1000); // 10 min ago
    insertReturn.mockResolvedValueOnce([
      { id: 'w1', createdAt: past, updatedAt: NOW },
    ]);
    const result = await joinWaitlist(undefined as never, fd({ email: 'a@b.com' }));
    expect(result.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('passes null for useCase when the field is empty/whitespace', async () => {
    await joinWaitlist(undefined as never, fd({
      email: 'a@b.com',
      useCase: '   ',
    }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      useCase: null,
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm vitest run src/app/waitlist/__tests__/actions.test.ts
```

Expected: FAIL with "Cannot find module '../actions'".

- [ ] **Step 3: Write the action**

Create `src/app/waitlist/actions.ts`:

```ts
'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { waitlistSignups } from '@/lib/db/schema';
import { acquireRateLimit } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email';
import { waitlistAdminNotification } from '@/lib/email/templates/waitlist-admin-notification';
import { hashIp } from '@/lib/ip-hash';
import { createLogger } from '@/lib/logger';

const log = createLogger('waitlist:join');

const schema = z.object({
  email: z
    .string()
    .min(3)
    .max(254)
    .email()
    .transform((v) => v.trim().toLowerCase()),
  useCase: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  referer: z.enum(['denied', 'landing', 'no-email']).optional(),
  company: z.string().optional(), // honeypot — must be empty
});

export type JoinWaitlistState = {
  ok: boolean;
  error?: string;
  alreadyOnList?: boolean;
};

export async function joinWaitlist(
  _prev: JoinWaitlistState | undefined,
  formData: FormData,
): Promise<JoinWaitlistState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    useCase: formData.get('useCase') ?? undefined,
    referer: formData.get('referer') ?? undefined,
    company: formData.get('company') ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please enter a valid email.',
    };
  }

  // Honeypot tripped — silent success so bots can't probe for the gate.
  if (parsed.data.company && parsed.data.company.trim() !== '') {
    log.info('honeypot tripped', { email: parsed.data.email });
    return { ok: true, alreadyOnList: false };
  }

  const ip =
    (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const rl = await acquireRateLimit(`waitlist:${ip}`, 60);
  if (!rl.allowed) {
    return {
      ok: false,
      error: 'Too many requests. Try again in a minute.',
    };
  }

  const ipHash = hashIp(ip);

  const rows = await db
    .insert(waitlistSignups)
    .values({
      email: parsed.data.email,
      useCase: parsed.data.useCase,
      referer: parsed.data.referer ?? null,
      ipHash,
    })
    .onConflictDoUpdate({
      target: waitlistSignups.email,
      set: {
        useCase: parsed.data.useCase,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: waitlistSignups.id,
      createdAt: waitlistSignups.createdAt,
      updatedAt: waitlistSignups.updatedAt,
    });

  const row = rows[0];
  if (!row) {
    log.error('waitlist insert returned no row', { email: parsed.data.email });
    return { ok: false, error: 'Something went wrong. Try again.' };
  }

  // Treat as "new" if updatedAt is within 1s of createdAt. ON CONFLICT
  // path always bumps updatedAt → that diverges from createdAt.
  const isNew =
    Math.abs(row.updatedAt.getTime() - row.createdAt.getTime()) < 1000;

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

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm vitest run src/app/waitlist/__tests__/actions.test.ts
pnpm tsc --noEmit
```

Expected: 6 tests passing; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/waitlist/actions.ts \
        src/app/waitlist/__tests__/actions.test.ts
git commit -m "feat(waitlist): add joinWaitlist server action

Validates email + optional use-case via zod. Trips silently on
honeypot (no DB write, no email). Rate-limits to 1 submit/IP/60s
via existing acquireRateLimit. Upserts on email (case-insensitive
via citext) so resubmissions just update the use-case. Skips admin
notification when the row already existed."
```

---

## Task 7: Waitlist page (`/waitlist`)

**Files:**
- Create: `src/app/waitlist/page.tsx`
- Create: `src/app/waitlist/_components/context-banner.tsx`
- Create: `src/app/waitlist/_components/waitlist-form.tsx`

- [ ] **Step 1: Write the context banner (server component)**

Create `src/app/waitlist/_components/context-banner.tsx`:

```tsx
export type BannerVariant = 'denied' | 'no-email' | 'landing';

const COPY: Record<BannerVariant, { headline: string; sub: string }> = {
  denied: {
    headline: "Your GitHub email isn't on the alpha list yet.",
    sub: "Drop your details — we'll get back to you when a slot opens.",
  },
  'no-email': {
    headline: "GitHub didn't share your email.",
    sub: "Enter it below and we'll add you to the waitlist.",
  },
  landing: {
    headline: 'ShipFlare is in private alpha.',
    sub: "Request access — we're inviting design partners in waves.",
  },
};

export function ContextBanner({ variant }: { variant: BannerVariant }) {
  const copy = COPY[variant];
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '64px 24px 24px',
        color: 'var(--sf-fg-on-dark-1)',
        maxWidth: 640,
        margin: '0 auto',
      }}
    >
      <h1
        style={{
          fontSize: 'var(--sf-text-h1)',
          fontWeight: 600,
          letterSpacing: 'var(--sf-track-tight)',
          margin: '0 0 12px',
        }}
      >
        {copy.headline}
      </h1>
      <p
        style={{
          fontSize: 'var(--sf-text-lg)',
          color: 'var(--sf-fg-on-dark-2)',
          margin: 0,
        }}
      >
        {copy.sub}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Write the client-side form**

Create `src/app/waitlist/_components/waitlist-form.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import {
  joinWaitlist,
  type JoinWaitlistState,
} from '../actions';

const INITIAL: JoinWaitlistState = { ok: false };

export interface WaitlistFormProps {
  initialEmail: string;
  referer: 'denied' | 'landing' | 'no-email';
}

export function WaitlistForm({ initialEmail, referer }: WaitlistFormProps) {
  const [state, formAction] = useActionState(joinWaitlist, INITIAL);

  if (state.ok) {
    return (
      <div
        style={{
          maxWidth: 480,
          margin: '0 auto 96px',
          padding: 32,
          background: 'var(--sf-bg-dark-surface)',
          borderRadius: 'var(--sf-radius-lg)',
          color: 'var(--sf-fg-on-dark-1)',
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            fontSize: 'var(--sf-text-h2)',
            margin: '0 0 8px',
            fontWeight: 600,
          }}
        >
          You're on the list.
        </h2>
        <p style={{ color: 'var(--sf-fg-on-dark-2)', margin: '0 0 24px' }}>
          We'll email you when a slot opens.
        </p>
        <Link
          href="/"
          style={{
            color: 'var(--sf-accent)',
            textDecoration: 'underline',
          }}
        >
          ← Back to home
        </Link>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      style={{
        maxWidth: 480,
        margin: '0 auto 96px',
        padding: 32,
        background: 'var(--sf-bg-dark-surface)',
        borderRadius: 'var(--sf-radius-lg)',
        color: 'var(--sf-fg-on-dark-1)',
      }}
    >
      <label
        htmlFor="waitlist-email"
        style={{ display: 'block', fontSize: 14, marginBottom: 6 }}
      >
        Email
      </label>
      <input
        id="waitlist-email"
        name="email"
        type="email"
        required
        defaultValue={initialEmail}
        autoComplete="email"
        style={inputStyle}
      />

      <label
        htmlFor="waitlist-usecase"
        style={{ display: 'block', fontSize: 14, marginTop: 16, marginBottom: 6 }}
      >
        What would you use ShipFlare for?{' '}
        <span style={{ color: 'var(--sf-fg-on-dark-3)' }}>(optional)</span>
      </label>
      <textarea
        id="waitlist-usecase"
        name="useCase"
        maxLength={500}
        rows={3}
        placeholder="A few words about what you'd like to ship faster."
        style={{ ...inputStyle, resize: 'vertical' }}
      />

      <input type="hidden" name="referer" value={referer} />

      {/* Honeypot — bots fill, humans don't see. */}
      <input
        name="company"
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        style={{
          position: 'absolute',
          left: '-9999px',
          opacity: 0,
          pointerEvents: 'none',
          height: 0,
          width: 0,
        }}
      />

      {state.error ? (
        <p
          role="alert"
          style={{
            color: 'var(--sf-danger)',
            fontSize: 13,
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={{
        marginTop: 20,
        width: '100%',
        minHeight: 44,
        background: 'var(--sf-accent)',
        color: 'var(--sf-fg-on-accent)',
        border: 'none',
        borderRadius: 'var(--sf-radius-md)',
        fontSize: 15,
        fontWeight: 600,
        cursor: pending ? 'wait' : 'pointer',
        opacity: pending ? 0.7 : 1,
      }}
    >
      {pending ? 'Sending…' : 'Request access'}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--sf-bg-dark)',
  color: 'var(--sf-fg-on-dark-1)',
  border: '1px solid var(--sf-border-on-dark)',
  borderRadius: 'var(--sf-radius-sm)',
  fontSize: 15,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
```

- [ ] **Step 3: Write the page**

Create `src/app/waitlist/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { GlassNav } from '@/components/marketing/glass-nav';
import { FooterStrip } from '@/components/marketing/footer-strip';
import { ContextBanner, type BannerVariant } from './_components/context-banner';
import { WaitlistForm } from './_components/waitlist-form';

interface WaitlistPageProps {
  searchParams: Promise<{
    from?: string;
    email?: string;
    reason?: string;
  }>;
}

const emailSchema = z.string().email().max(254);

export default async function WaitlistPage({ searchParams }: WaitlistPageProps) {
  // Already signed in → no point showing the waitlist
  const session = await auth();
  if (session?.user?.id) redirect('/today');

  const sp = await searchParams;

  // Determine which banner variant to show
  const variant: BannerVariant =
    sp.reason === 'no-email'
      ? 'no-email'
      : sp.from === 'denied'
        ? 'denied'
        : 'landing';

  // Pre-fill email only if it parses as a valid email — XSS guard
  const parsed = emailSchema.safeParse(sp.email);
  const initialEmail = parsed.success ? parsed.data : '';

  return (
    <main
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--sf-bg-dark)' }}
    >
      <GlassNav isAuthenticated={false} />
      <ContextBanner variant={variant} />
      <WaitlistForm initialEmail={initialEmail} referer={variant} />
      <FooterStrip />
    </main>
  );
}

export const metadata = {
  title: 'Request alpha access — ShipFlare',
  robots: { index: false, follow: false },
};
```

- [ ] **Step 4: Verify the page builds and renders**

Start dev server in one terminal:
```bash
pnpm dev
```

In another terminal, hit it:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/waitlist
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/waitlist?from=denied&email=test%40example.com"
```

Expected: both return 200.

Open `http://localhost:3000/waitlist?from=denied&email=test%40example.com` in a browser. Verify:
- Banner reads "Your GitHub email isn't on the alpha list yet."
- Email field is pre-filled with `test@example.com`
- Use-case textarea is empty
- Submit button reads "Request access"

Also run type check:
```bash
pnpm tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/waitlist/
git commit -m "feat(waitlist): add /waitlist page with context-aware banner

Server component renders one of three banner variants (denied / no-email /
landing) based on query params. Form is a client component using
useActionState + useFormStatus. Honeypot field for spam control.
Pre-fills email from ?email= only after zod validates it (XSS guard).
Already-signed-in users redirect to /today."
```

---

## Task 8: Landing page reframe + delete `AccessDeniedBanner`

**Files:**
- Modify: `src/components/marketing/hero-demo.tsx`
- Modify: `src/components/marketing/cta-section.tsx`
- Modify: `src/app/page.tsx`
- Delete: `src/components/marketing/access-denied-banner.tsx`

- [ ] **Step 1: Update the hero CTA**

Open `src/components/marketing/hero-demo.tsx`. Find the unauthenticated CTA block (currently triggers `setSignInOpen(true)` for "Continue with GitHub"). Add a `Link` import at the top:

```ts
import Link from 'next/link';
```

Then replace the unauthenticated primary-CTA button with two elements:

1. A primary `<Link href="/waitlist">` styled exactly like the existing primary CTA pill
2. Below it, a small secondary button that opens the existing `SignInModal`

The exact wrapping markup depends on the current JSX shape — locate where `isAuthenticated ? ... : ...` produces the unauth CTA and replace the unauth branch. Pattern:

```tsx
{isAuthenticated ? (
  <Link href="/today" className="cta-primary">
    Open dashboard
  </Link>
) : (
  <>
    <Link href="/waitlist" className="cta-primary">
      Request alpha access
    </Link>
    <button
      type="button"
      onClick={() => setSignInOpen(true)}
      style={{
        marginTop: 12,
        background: 'transparent',
        border: 'none',
        color: 'var(--sf-fg-on-dark-3)',
        fontSize: 14,
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 3,
      }}
    >
      Already invited? Sign in with GitHub
    </button>
  </>
)}
```

(Adapt the class names / inline styles to match what's already present in the file — keep the visual treatment for the primary CTA identical.)

- [ ] **Step 2: Update the bottom CTA section**

Open `src/components/marketing/cta-section.tsx`. Apply the same treatment as the hero — primary becomes `<Link href="/waitlist">Request alpha access</Link>`; "Continue with GitHub" demotes to small link/button below it.

- [ ] **Step 3: Remove `AccessDeniedBanner` from the home page**

Open `src/app/page.tsx`. Make these edits:

1. Remove the import line `import { AccessDeniedBanner } from '@/components/marketing/access-denied-banner';`
2. In the `HomePage` component signature, remove the `searchParams` prop entirely (it's only used for `error`):
   ```tsx
   export default async function HomePage() {
   ```
3. Remove the lines that compute `accessDenied`:
   ```tsx
   const sp = await searchParams;
   const accessDenied = sp.error === 'AccessDenied';
   ```
4. Remove the JSX render `{accessDenied ? <AccessDeniedBanner /> : null}`

- [ ] **Step 4: Delete the banner component**

Run:
```bash
git rm src/components/marketing/access-denied-banner.tsx
```

Also check for any test file:
```bash
grep -rE "AccessDeniedBanner|access-denied-banner" src/ e2e/ 2>/dev/null
```

If any references remain (e.g., test file), delete them too.

- [ ] **Step 5: Verify build**

Run:
```bash
pnpm tsc --noEmit
pnpm build
```

Expected: both exit 0.

Also open `http://localhost:3000` in a browser (dev server still running from Task 7) and visually verify:
- Hero now shows "Request alpha access" as the primary CTA
- Clicking it goes to `/waitlist`
- The "Already invited?" link still opens the sign-in modal

- [ ] **Step 6: Commit**

```bash
git add src/components/marketing/ src/app/page.tsx
git commit -m "feat(marketing): reframe landing CTAs around /waitlist

Unauthenticated hero + bottom CTA primary actions now link to
/waitlist (Request alpha access). GitHub sign-in demoted to a small
'Already invited?' link below — still discoverable for allowlisted
users but no longer the default CTA.

AccessDeniedBanner deleted — no longer reachable now that rejected
sign-ins redirect to /waitlist."
```

---

## Task 9: Admin waitlist tab + approve/dismiss actions

**Files:**
- Modify: `src/app/(app)/admin/invites/page.tsx`
- Modify: `src/app/(app)/admin/invites/actions.ts`
- Create: `src/app/(app)/admin/invites/_components/waitlist-tab.tsx`
- Create: `src/app/(app)/admin/invites/_components/waitlist-actions-buttons.tsx`
- Modify: `src/app/(app)/admin/invites/__tests__/actions.test.ts`

- [ ] **Step 1: Write failing tests for the new actions**

Open `src/app/(app)/admin/invites/__tests__/actions.test.ts` and append (or, if it doesn't exist, create with the existing test scaffolding pattern):

```ts
import {
  approveWaitlistSignup,
  dismissWaitlistSignup,
} from '../actions';
import { db } from '@/lib/db';
import { allowedEmails, waitlistSignups } from '@/lib/db/schema';

// Add these tests inside the existing describe block

describe('approveWaitlistSignup', () => {
  it('requires admin', async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(approveWaitlistSignup('w-id-1')).rejects.toThrow('not admin');
  });

  it('inserts into allowed_emails and updates the waitlist row in a transaction', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce('admin@x.com');
    // mock the waitlist row lookup
    selectFromMock.mockResolvedValueOnce([
      { id: 'w-id-1', email: 'newuser@example.com' },
    ]);

    const result = await approveWaitlistSignup('w-id-1');

    expect(result).toEqual({ ok: true });
    // allowed_emails INSERT with un-revoke on conflict
    expect(insertIntoAllowed).toHaveBeenCalled();
    // waitlist_signups UPDATE
    expect(updateWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedBy: 'admin@x.com',
      }),
    );
  });

  it('sends an approval email to the applicant fire-and-forget', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([
      { id: 'w-id-1', email: 'newuser@example.com' },
    ]);

    await approveWaitlistSignup('w-id-1');

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'newuser@example.com' }),
    );
  });

  it('does not fail the action when the approval email errors', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([
      { id: 'w-id-1', email: 'newuser@example.com' },
    ]);
    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'smtp' });

    const result = await approveWaitlistSignup('w-id-1');
    expect(result).toEqual({ ok: true });
  });

  it('returns error when the waitlist row is not found', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([]);
    const result = await approveWaitlistSignup('nope');
    expect(result).toEqual({ ok: false, error: 'Waitlist row not found.' });
  });
});

describe('dismissWaitlistSignup', () => {
  it('requires admin', async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(dismissWaitlistSignup('w-id-1')).rejects.toThrow('not admin');
  });

  it('marks the row dismissed_at + dismissed_by', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce('admin@x.com');
    await dismissWaitlistSignup('w-id-1');
    expect(updateWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({
        dismissedBy: 'admin@x.com',
      }),
    );
  });

  it('does not send any email', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce('admin@x.com');
    await dismissWaitlistSignup('w-id-1');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
```

Add the mock scaffolding at the top of the file (alongside any existing mocks) to wire `insertIntoAllowed`, `updateWaitlist`, `selectFromMock`, `sendEmailMock`. Match the in-file pattern for the existing `addInvite`/`revokeInvite` tests — replicate the same Drizzle-builder mock chain.

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm vitest run src/app/\(app\)/admin/invites/__tests__/actions.test.ts
```

Expected: FAIL with "approveWaitlistSignup is not exported" etc.

- [ ] **Step 3: Implement the new actions**

Open `src/app/(app)/admin/invites/actions.ts`. Append below the existing `updateNote` action:

```ts
import { waitlistSignups } from '@/lib/db/schema';
import { sendEmail } from '@/lib/email';
import { waitlistApproved } from '@/lib/email/templates/waitlist-approved';

const idSchema = z.object({ id: z.string().uuid() });

/**
 * Approve a waitlist signup → insert into allowed_emails (un-revoke on
 * conflict) and stamp the waitlist row with approved_at/approved_by.
 *
 * Both writes run inside a single transaction so a partial failure
 * doesn't leave the row marked approved without the corresponding
 * allowlist entry.
 *
 * Sends the applicant a friendly "you're in" email after the
 * transaction commits — fire-and-forget; a Resend failure doesn't fail
 * the action (the founder can resend manually via the dashboard later).
 */
export async function approveWaitlistSignup(
  id: string,
): Promise<ActionResult> {
  const adminEmail = await requireAdmin();
  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, error: 'Invalid id.' };

  // Look up the email before the transaction so we can use it for both
  // the insert and the email.
  const rows = await db
    .select({ id: waitlistSignups.id, email: waitlistSignups.email })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.id, parsed.data.id))
    .limit(1);
  if (rows.length === 0) {
    return { ok: false, error: 'Waitlist row not found.' };
  }
  const row = rows[0];

  await db.transaction(async (tx) => {
    await tx
      .insert(allowedEmails)
      .values({
        email: row.email,
        invitedBy: adminEmail,
        note: 'Approved from waitlist',
      })
      .onConflictDoUpdate({
        target: allowedEmails.email,
        set: {
          revokedAt: null,
          invitedBy: adminEmail,
        },
      });

    await tx
      .update(waitlistSignups)
      .set({
        approvedAt: new Date(),
        approvedBy: adminEmail,
      })
      .where(eq(waitlistSignups.id, row.id));
  });

  // Fire-and-forget email — don't block on Resend
  const result = await sendEmail(waitlistApproved({ email: row.email }));
  if (!result.ok) {
    log.warn('approval email failed but action succeeded', {
      email: row.email,
      reason: result.reason,
    });
  }

  revalidatePath('/admin/invites');
  return { ok: true };
}

/**
 * Soft-dismiss a waitlist signup. No email sent — reversible by
 * the admin from the Dismissed filter view.
 */
export async function dismissWaitlistSignup(
  id: string,
): Promise<ActionResult> {
  const adminEmail = await requireAdmin();
  const parsed = idSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, error: 'Invalid id.' };

  await db
    .update(waitlistSignups)
    .set({
      dismissedAt: new Date(),
      dismissedBy: adminEmail,
    })
    .where(eq(waitlistSignups.id, parsed.data.id));

  revalidatePath('/admin/invites');
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
pnpm vitest run src/app/\(app\)/admin/invites/__tests__/actions.test.ts
```

Expected: all approve/dismiss tests passing.

- [ ] **Step 5: Build the waitlist tab UI**

Create `src/app/(app)/admin/invites/_components/waitlist-actions-buttons.tsx`:

```tsx
'use client';

import { useTransition } from 'react';
import {
  approveWaitlistSignup,
  dismissWaitlistSignup,
} from '../actions';

export function WaitlistActionsButtons({ id }: { id: string }) {
  const [pending, start] = useTransition();

  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => approveWaitlistSignup(id).then(() => {}))}
        style={{
          padding: '4px 10px',
          background: 'var(--sf-accent)',
          color: 'var(--sf-fg-on-accent)',
          border: 'none',
          borderRadius: 4,
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
          opacity: pending ? 0.7 : 1,
        }}
      >
        Approve
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(() => dismissWaitlistSignup(id).then(() => {}))}
        style={{
          padding: '4px 10px',
          background: 'transparent',
          color: 'var(--sf-fg-3)',
          border: '1px solid var(--sf-border-1)',
          borderRadius: 4,
          fontSize: 12,
          cursor: pending ? 'wait' : 'pointer',
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
```

Create `src/app/(app)/admin/invites/_components/waitlist-tab.tsx`:

```tsx
import { sql, and, isNull, isNotNull, desc, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { waitlistSignups } from '@/lib/db/schema';
import { WaitlistActionsButtons } from './waitlist-actions-buttons';

type Status = 'pending' | 'approved' | 'dismissed';

export async function WaitlistTab({ status }: { status: Status }) {
  const where =
    status === 'pending'
      ? and(
          isNull(waitlistSignups.approvedAt),
          isNull(waitlistSignups.dismissedAt),
        )
      : status === 'approved'
        ? isNotNull(waitlistSignups.approvedAt)
        : isNotNull(waitlistSignups.dismissedAt);

  const orderBy =
    status === 'pending'
      ? asc(waitlistSignups.createdAt)
      : desc(waitlistSignups.createdAt);

  const rows = await db
    .select({
      id: waitlistSignups.id,
      email: waitlistSignups.email,
      useCase: waitlistSignups.useCase,
      referer: waitlistSignups.referer,
      createdAt: waitlistSignups.createdAt,
      approvedAt: waitlistSignups.approvedAt,
      approvedBy: waitlistSignups.approvedBy,
      dismissedAt: waitlistSignups.dismissedAt,
      dismissedBy: waitlistSignups.dismissedBy,
    })
    .from(waitlistSignups)
    .where(where)
    .orderBy(orderBy);

  if (rows.length === 0) {
    const emptyCopy =
      status === 'pending'
        ? 'No pending waitlist signups.'
        : status === 'approved'
          ? 'No approved signups yet.'
          : 'No dismissed signups.';
    return (
      <p style={{ color: 'var(--sf-fg-3)', fontSize: 13, padding: '24px 0' }}>
        {emptyCopy}
      </p>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--sf-fg-3)' }}>
          <th style={th}>Email</th>
          <th style={th}>Use case</th>
          <th style={th}>Source</th>
          <th style={th}>Submitted</th>
          {status === 'pending' && (
            <th style={{ ...th, textAlign: 'right' }}>Actions</th>
          )}
          {status === 'approved' && <th style={th}>Approved by</th>}
          {status === 'dismissed' && <th style={th}>Dismissed by</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: '1px solid var(--sf-border-1)' }}>
            <td style={td}>{r.email}</td>
            <td style={td}>{r.useCase ?? '—'}</td>
            <td style={td}>{r.referer ?? '—'}</td>
            <td style={td}>{r.createdAt.toLocaleDateString()}</td>
            {status === 'pending' && (
              <td style={td}>
                <WaitlistActionsButtons id={r.id} />
              </td>
            )}
            {status === 'approved' && <td style={td}>{r.approvedBy ?? '—'}</td>}
            {status === 'dismissed' && (
              <td style={td}>{r.dismissedBy ?? '—'}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { padding: '8px 6px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '8px 6px' };
```

- [ ] **Step 6: Wire tabs into `/admin/invites/page.tsx`**

Open `src/app/(app)/admin/invites/page.tsx`. Add a `searchParams` prop and route between two views:

```tsx
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { waitlistSignups, allowedEmails, users } from '@/lib/db/schema';
import { getPartnerActivityCounts } from '@/lib/admin/partner-activity';
import { InviteForm } from './_components/invite-form';
import { RevokeButton } from './_components/revoke-button';
import { NoteCell } from './_components/note-cell';
import { WaitlistTab } from './_components/waitlist-tab';

interface PageProps {
  searchParams: Promise<{ tab?: string; status?: string }>;
}

export default async function AdminInvitesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = sp.tab === 'waitlist' ? 'waitlist' : 'invites';
  const status =
    sp.status === 'approved' || sp.status === 'dismissed'
      ? sp.status
      : 'pending';

  // Counts for the badges — runs unconditionally so both tabs show counts.
  const [{ pending, approved, dismissed }] = await db
    .select({
      pending: sql<number>`count(*) filter (where approved_at is null and dismissed_at is null)`,
      approved: sql<number>`count(*) filter (where approved_at is not null)`,
      dismissed: sql<number>`count(*) filter (where dismissed_at is not null)`,
    })
    .from(waitlistSignups);

  return (
    <div>
      <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 500 }}>
        Design partner invites
      </h2>

      {/* Tab strip */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          borderBottom: '1px solid var(--sf-border-1)',
          marginBottom: 24,
        }}
      >
        <TabLink href="/admin/invites" active={tab === 'invites'}>
          Invites
        </TabLink>
        <TabLink href="/admin/invites?tab=waitlist" active={tab === 'waitlist'}>
          Waitlist {Number(pending) > 0 ? `(${pending})` : ''}
        </TabLink>
      </div>

      {tab === 'invites' ? (
        <InvitesTabContent />
      ) : (
        <>
          {/* Status filter chips */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=pending"
              active={status === 'pending'}
            >
              Pending ({pending})
            </FilterChip>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=approved"
              active={status === 'approved'}
            >
              Approved ({approved})
            </FilterChip>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=dismissed"
              active={status === 'dismissed'}
            >
              Dismissed ({dismissed})
            </FilterChip>
          </div>
          <WaitlistTab status={status} />
        </>
      )}
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: '10px 0',
        borderBottom: active ? '2px solid var(--sf-accent)' : '2px solid transparent',
        color: active ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
        textDecoration: 'none',
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        marginBottom: -1,
      }}
    >
      {children}
    </Link>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: '4px 12px',
        borderRadius: 999,
        background: active ? 'var(--sf-bg-3)' : 'transparent',
        color: active ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
        border: '1px solid var(--sf-border-1)',
        fontSize: 12,
        textDecoration: 'none',
      }}
    >
      {children}
    </Link>
  );
}

// Existing invites view — extract into its own server component
async function InvitesTabContent() {
  const rows = await db
    .select({
      email: allowedEmails.email,
      invitedAt: allowedEmails.invitedAt,
      invitedBy: allowedEmails.invitedBy,
      note: allowedEmails.note,
      revokedAt: allowedEmails.revokedAt,
      hasUser: sql<boolean>`${users.id} IS NOT NULL`,
      userId: users.id,
      lastLoginAt: users.lastLoginAt,
    })
    .from(allowedEmails)
    .leftJoin(users, sql`LOWER(${users.email}) = ${allowedEmails.email}`)
    .orderBy(sql`${allowedEmails.invitedAt} desc`);

  const userIds = rows
    .map((r) => r.userId)
    .filter((id): id is string => id !== null);
  const activity = await getPartnerActivityCounts(userIds);

  // ... preserve the EXISTING table-rendering JSX from the original
  // page.tsx body — just lifted into this function. Do not redesign;
  // a copy-paste of the current rendering is correct.
  return (
    <>
      <p style={{ marginTop: 0, fontSize: 13, color: 'var(--sf-fg-3)' }}>
        Manage allowlisted emails. Sign-in is rejected for any GitHub email
        not listed here (or matching <code>SUPER_ADMIN_EMAIL</code>).
      </p>
      <InviteForm />
      {/* TABLE COPIED FROM ORIGINAL — see original page.tsx for full markup */}
      {/* When implementing: copy the existing <table>...</table> block verbatim */}
    </>
  );
}
```

**Important:** When implementing Step 6, copy the existing invites `<table>...</table>` and supporting JSX from the original `page.tsx` verbatim into `InvitesTabContent`. Do not redesign — just relocate.

- [ ] **Step 7: Verify the admin tab end-to-end**

Run dev server (`pnpm dev`), sign in as `SUPER_ADMIN_EMAIL`, navigate to:
- `http://localhost:3000/admin/invites` — should show the invites tab with the existing table
- `http://localhost:3000/admin/invites?tab=waitlist` — should show the waitlist tab with empty state

In a separate browser/incognito, hit `/waitlist`, submit a fake email. Refresh `/admin/invites?tab=waitlist` — verify the row appears.

Click Approve. Verify:
- Row disappears from Pending; appears in Approved (filter to it)
- `/admin/invites` (invites tab) shows the email
- (If `RESEND_API_KEY` is set in `.env.local`) approval email arrives

Run type check + tests:
```bash
pnpm tsc --noEmit
pnpm vitest run src/app/\(app\)/admin/invites/__tests__/actions.test.ts
```

Expected: tsc exit 0; tests passing.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(app\)/admin/invites/
git commit -m "feat(admin): add waitlist tab + approve/dismiss actions

Tab strip on /admin/invites with Pending/Approved/Dismissed filter
chips. Approve runs in a transaction (allowed_emails upsert with
un-revoke + waitlist row stamp) and sends a fire-and-forget
'you're in' email. Dismiss is reversible from the Dismissed filter
view."
```

---

## Task 10: `.env.example` + setup docs

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the three new env vars**

Open `.env.example`. At the bottom (or wherever miscellaneous config lives), append:

```bash
# ---- Alpha gate / waitlist ----

# Random 32-byte hex used to salt SHA-256 of waitlist submitter IPs.
# Generate once per environment:
#   openssl rand -hex 32
# When unset, IP hashing is disabled (waitlist rows store null ipHash).
IP_HASH_SALT=

# ---- Email (Resend) ----

# Resend API key. When unset, sendEmail() is a graceful no-op (logs warn).
# Required in prod for admin notifications + approval emails.
RESEND_API_KEY=

# Verified Resend sender. Required when RESEND_API_KEY is set.
# e.g. alpha@mail.shipflare.app
EMAIL_FROM=
```

- [ ] **Step 2: Verify nothing is broken**

```bash
pnpm tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document IP_HASH_SALT, RESEND_API_KEY, EMAIL_FROM

All three are optional in dev — app boots without them; waitlist
flow degrades gracefully (no IP hash, no admin notification email)."
```

---

## Task 11: Playwright E2E test for the alpha gate

**Files:**
- Create: `e2e/tests/alpha-gate.spec.ts`

- [ ] **Step 1: Locate existing E2E patterns**

Run:
```bash
ls e2e/tests/
cat e2e/playwright.config.ts 2>/dev/null | head -30
cat e2e/tests/team-chat.live-smoke.ts 2>/dev/null | head -40
```

Note the existing fixtures/helpers/auth-setup patterns. Match them.

- [ ] **Step 2: Write the test**

Create `e2e/tests/alpha-gate.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// These tests exercise the public-facing waitlist flow without
// requiring real GitHub OAuth. They cover:
//   1. Anonymous user hits /waitlist directly → form renders
//   2. Submitting the form → success card
//   3. Pre-fill from ?email= → input value matches
//   4. Landing CTA → /waitlist (no GitHub roundtrip needed)
//
// The full "GitHub-denied → /waitlist redirect → admin approves →
// re-signin succeeds" loop is covered by a manual smoke run
// documented in README — automating mock OAuth in Playwright is
// out of scope for v1.

test.describe('Alpha gate — waitlist flow', () => {
  test('landing primary CTA links to /waitlist', async ({ page }) => {
    await page.goto('/');
    const requestAccess = page.getByRole('link', { name: /request alpha access/i }).first();
    await expect(requestAccess).toBeVisible();
    await requestAccess.click();
    await expect(page).toHaveURL(/\/waitlist/);
  });

  test('waitlist page renders the "landing" banner when no query params', async ({ page }) => {
    await page.goto('/waitlist');
    await expect(page.getByRole('heading', { name: /private alpha/i })).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeEmpty();
  });

  test('waitlist page pre-fills email and shows "denied" banner from query params', async ({ page }) => {
    await page.goto('/waitlist?from=denied&email=test%40example.com');
    await expect(
      page.getByRole('heading', { name: /isn't on the alpha list/i }),
    ).toBeVisible();
    await expect(page.locator('input[name="email"]')).toHaveValue('test@example.com');
  });

  test('submitting the form shows the success card', async ({ page }) => {
    const email = `e2e-${Date.now()}@example.com`;
    await page.goto('/waitlist');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('textarea[name="useCase"]').fill('e2e smoke');
    await page.getByRole('button', { name: /request access/i }).click();
    await expect(page.getByRole('heading', { name: /you're on the list/i })).toBeVisible();
  });

  test('invalid email surfaces a friendly error and form stays editable', async ({ page }) => {
    await page.goto('/waitlist');
    await page.locator('input[name="email"]').fill('not-an-email');
    // browser-side type=email validation will block submission; bypass by
    // setting the input attribute then submitting
    await page.locator('input[name="email"]').evaluate((el: HTMLInputElement) => {
      el.removeAttribute('required');
      el.setAttribute('type', 'text');
    });
    await page.getByRole('button', { name: /request access/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the test against a local dev server**

In one terminal:
```bash
pnpm dev
```

In another:
```bash
pnpm playwright test e2e/tests/alpha-gate.spec.ts
```

Expected: 5 tests passing.

If the existing Playwright config requires `BASE_URL` env var, set it first:
```bash
BASE_URL=http://localhost:3000 pnpm playwright test e2e/tests/alpha-gate.spec.ts
```

- [ ] **Step 4: Manual smoke for the GitHub OAuth path**

Per project memory `feedback_playwright_real_browser_in_plans`: the user has GitHub authenticated locally. Manually verify the full denied-redirect loop:

1. Start dev server: `pnpm dev`
2. In a regular browser, sign out from any existing ShipFlare session
3. Go to `/`, click "Already invited? Sign in with GitHub" — OR start fresh by visiting `/api/auth/signin/github`
4. Authenticate as a GitHub user whose email is NOT in `allowed_emails`
5. Verify you land on `/waitlist?from=denied&email=<your-github-email>` with the banner reading "Your GitHub email isn't on the alpha list yet" and the email field pre-filled
6. Fill use-case and submit; verify success card
7. Sign in as `SUPER_ADMIN_EMAIL`, navigate to `/admin/invites?tab=waitlist`, find the row, click Approve
8. Sign out, sign back in via GitHub with the previously-rejected email; verify landing on `/today`

Document any issues found in this run as a follow-up bug commit.

- [ ] **Step 5: Commit**

```bash
git add e2e/tests/alpha-gate.spec.ts
git commit -m "test(e2e): Playwright spec for /waitlist flow

Covers the public waitlist surface: landing CTA → /waitlist link,
banner variants by query params, pre-fill from ?email=, form submit
success, invalid-email error path. Full OAuth denied-redirect loop
verified by manual smoke in the dev environment (documented in
plan task 11 step 4)."
```

---

## Task 12: Phase 1 final verification

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
pnpm tsc --noEmit
pnpm build
```

Expected: all green; tsc exit 0; build succeeds.

- [ ] **Step 2: Verify coverage on touched modules**

```bash
pnpm vitest run --coverage \
  src/lib/auth/ \
  src/lib/email/ \
  src/lib/ip-hash.ts \
  src/lib/__tests__/ip-hash.test.ts \
  src/app/waitlist/ \
  src/app/\(app\)/admin/invites/
```

Expected: coverage ≥ 80% per project rule.

- [ ] **Step 3: Push and open PR for Phase 1**

```bash
git push -u origin dev
gh pr create --title "Alpha gate + waitlist + admin tab (Phase 1)" --body "$(cat <<'EOF'
## Summary
- Re-enables the email allowlist gate removed in 704b019
- Rejected sign-ins now redirect to /waitlist (pre-filled email)
- /waitlist page captures email + optional use-case; Resend admin notif on new row (no-op without env vars)
- /admin/invites gains a Waitlist tab with 1-click Approve (transactional allowed_emails upsert) + applicant approval email
- Landing CTAs reframed: primary becomes "Request alpha access"; GitHub sign-in demoted to small "Already invited?" link
- New env vars: IP_HASH_SALT, RESEND_API_KEY, EMAIL_FROM (all optional in dev)

## Test plan
- [ ] pnpm test green
- [ ] pnpm tsc --noEmit exit 0
- [ ] pnpm build succeeds
- [ ] pnpm playwright test e2e/tests/alpha-gate.spec.ts passes
- [ ] Manual smoke: GitHub sign-in as non-allowlisted user → /waitlist redirect → submit → admin approves → re-signin succeeds
- [ ] Admin notification email arrives (with RESEND_API_KEY set)

Spec: docs/superpowers/specs/2026-05-11-alpha-gate-and-waitlist-design.md
EOF
)"
```

- [ ] **Step 4: Wait for CI; merge**

After CI passes, merge via "Create a merge commit" (per project memory `feedback_pr_merge_use_merge_commit`). After merge, immediately fast-forward `dev` to `origin/main` to keep histories aligned.

---

# Phase 2 — Admin analytics

## Task 13: Sparkline component + test

**Files:**
- Create: `src/components/admin/sparkline.tsx`
- Create: `src/components/admin/__tests__/sparkline.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/admin/__tests__/sparkline.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline } from '../sparkline';

describe('Sparkline', () => {
  it('renders an SVG with one polyline', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4, 5]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('polyline').length).toBe(1);
  });

  it('renders an empty SVG when values is empty', () => {
    const { container } = render(<Sparkline values={[]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('polyline')).toBeNull();
  });

  it('normalizes points so min maps to bottom and max to top of viewBox', () => {
    const { container } = render(<Sparkline values={[0, 10]} width={100} height={20} />);
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const points = poly!.getAttribute('points')!;
    // 2 points: first at y=20 (min), second at y=0 (max), spread across x
    const parsed = points
      .split(' ')
      .map((p) => p.split(',').map(Number)) as [number, number][];
    expect(parsed.length).toBe(2);
    expect(parsed[0][1]).toBeCloseTo(20, 1);
    expect(parsed[1][1]).toBeCloseTo(0, 1);
  });

  it('handles all-zero series by rendering a flat baseline', () => {
    const { container } = render(<Sparkline values={[0, 0, 0]} height={20} />);
    const poly = container.querySelector('polyline');
    expect(poly).not.toBeNull();
    const ys = poly!
      .getAttribute('points')!
      .split(' ')
      .map((p) => Number(p.split(',')[1]));
    expect(new Set(ys).size).toBe(1); // all same y
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/components/admin/__tests__/sparkline.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Create `src/components/admin/sparkline.tsx`:

```tsx
export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
}

/**
 * Minimal inline-SVG sparkline. No deps. Renders an empty SVG when
 * values is empty. Flat baseline (mid-height) when all values are equal.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  stroke = 'var(--sf-accent)',
}: SparklineProps) {
  if (values.length === 0) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const step = values.length > 1 ? width / (values.length - 1) : 0;

  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = max === min ? height : height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/components/admin/__tests__/sparkline.test.tsx
```

Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/sparkline.tsx \
        src/components/admin/__tests__/sparkline.test.tsx
git commit -m "feat(admin): add minimal SVG Sparkline component

No chart library, no deps. Normalizes values to fit the viewBox,
flat baseline when the series is constant, empty SVG when there's
no data. Used by the /admin/analytics daily activity row."
```

---

## Task 14: Funnel query + component

**Files:**
- Create: `src/app/(app)/admin/analytics/_queries/funnel.ts`
- Create: `src/app/(app)/admin/analytics/_queries/__tests__/funnel.test.ts`
- Create: `src/app/(app)/admin/analytics/_components/funnel.tsx`

- [ ] **Step 1: Write the failing query test**

Create `src/app/(app)/admin/analytics/_queries/__tests__/funnel.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';

// Mock @/lib/db to use the in-memory store
import { createInMemoryStore } from '@/lib/test-utils/in-memory-db';
import {
  waitlistSignups,
  users,
  pipelineEvents,
  posts,
} from '@/lib/db/schema';

let store: ReturnType<typeof createInMemoryStore>;
vi.mock('@/lib/db', () => ({
  get db() {
    return store.db;
  },
}));

import { getFunnel } from '../funnel';

const NOW = new Date('2026-05-11T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86400_000);

describe('getFunnel', () => {
  beforeEach(() => {
    store = createInMemoryStore();
  });

  it('counts only rows within the 30-day window', async () => {
    store.waitlistSignups.push(
      { id: 'w1', email: 'a@x', createdAt: ago(5), approvedAt: null, dismissedAt: null } as never,
      { id: 'w2', email: 'b@x', createdAt: ago(40), approvedAt: null, dismissedAt: null } as never,
    );
    const result = await getFunnel({ now: NOW, windowDays: 30 });
    expect(result.waitlistSignups).toBe(1);
  });

  it('counts approvedAt within the window for approvedAllowlisted', async () => {
    store.waitlistSignups.push(
      { id: 'w1', email: 'a@x', createdAt: ago(40), approvedAt: ago(5), dismissedAt: null } as never,
    );
    const r = await getFunnel({ now: NOW, windowDays: 30 });
    expect(r.approvedAllowlisted).toBe(1);
  });

  it('counts new users by createdAt', async () => {
    store.users.push(
      { id: 'u1', email: 'a@x', createdAt: ago(5) } as never,
      { id: 'u2', email: 'b@x', createdAt: ago(50) } as never,
    );
    const r = await getFunnel({ now: NOW, windowDays: 30 });
    expect(r.signedUp).toBe(1);
  });

  it('counts distinct users who triggered a "discovered" pipeline event', async () => {
    store.pipelineEvents.push(
      { id: 'p1', userId: 'u1', stage: 'discovered', createdAt: ago(2) } as never,
      { id: 'p2', userId: 'u1', stage: 'discovered', createdAt: ago(1) } as never,
      { id: 'p3', userId: 'u2', stage: 'discovered', createdAt: ago(1) } as never,
    );
    const r = await getFunnel({ now: NOW, windowDays: 30 });
    expect(r.ranFirstScan).toBe(2);
  });

  it('counts distinct users with a posts.status=posted in window', async () => {
    store.posts.push(
      { id: 'p1', userId: 'u1', status: 'posted', postedAt: ago(2) } as never,
      { id: 'p2', userId: 'u1', status: 'draft', postedAt: ago(2) } as never,
      { id: 'p3', userId: 'u2', status: 'posted', postedAt: ago(40) } as never,
    );
    const r = await getFunnel({ now: NOW, windowDays: 30 });
    expect(r.publishedFirstPost).toBe(1);
  });
});
```

(If `in-memory-db.ts` doesn't yet support all four tables — `waitlistSignups`, `users`, `pipelineEvents`, `posts` — extend it in this step to include them. Match the pattern of existing tables in that file.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/funnel.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

Create `src/app/(app)/admin/analytics/_queries/funnel.ts`:

```ts
import { sql, and, gte, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  waitlistSignups,
  users,
  pipelineEvents,
  posts,
} from '@/lib/db/schema';

export interface FunnelCounts {
  waitlistSignups: number;
  approvedAllowlisted: number;
  signedUp: number;
  ranFirstScan: number;
  publishedFirstPost: number;
}

export interface FunnelOptions {
  now?: Date;
  windowDays?: number;
}

/**
 * Five-stage alpha funnel over the last `windowDays`:
 *
 *   waitlist signups → approved → first sign-in → first scan → first post
 *
 * Each stage is an independent count; conversion % is computed in the UI.
 * All five queries run in parallel via Promise.all.
 */
export async function getFunnel(opts: FunnelOptions = {}): Promise<FunnelCounts> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);

  const [
    [{ count: waitlistCount }],
    [{ count: approvedCount }],
    [{ count: signedUpCount }],
    [{ count: scanCount }],
    [{ count: postCount }],
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(waitlistSignups)
      .where(gte(waitlistSignups.createdAt, since)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(waitlistSignups)
      .where(
        and(
          isNotNull(waitlistSignups.approvedAt),
          gte(waitlistSignups.approvedAt, since),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(gte(users.createdAt, since)),
    db
      .select({
        count: sql<number>`count(distinct ${pipelineEvents.userId})::int`,
      })
      .from(pipelineEvents)
      .where(
        and(
          eq(pipelineEvents.stage, 'discovered'),
          gte(pipelineEvents.createdAt, since),
        ),
      ),
    db
      .select({ count: sql<number>`count(distinct ${posts.userId})::int` })
      .from(posts)
      .where(and(eq(posts.status, 'posted'), gte(posts.postedAt, since))),
  ]);

  return {
    waitlistSignups: Number(waitlistCount),
    approvedAllowlisted: Number(approvedCount),
    signedUp: Number(signedUpCount),
    ranFirstScan: Number(scanCount),
    publishedFirstPost: Number(postCount),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/funnel.test.ts
```

Expected: 5 tests passing. (If in-memory-db needed extensions, this is where that surfaces — extend, re-run.)

- [ ] **Step 5: Write the component**

Create `src/app/(app)/admin/analytics/_components/funnel.tsx`:

```tsx
import type { FunnelCounts } from '../_queries/funnel';

const STAGES: Array<{ key: keyof FunnelCounts; label: string }> = [
  { key: 'waitlistSignups', label: 'Waitlist signups' },
  { key: 'approvedAllowlisted', label: 'Approved → allowlisted' },
  { key: 'signedUp', label: 'Signed up' },
  { key: 'ranFirstScan', label: 'Ran first scan' },
  { key: 'publishedFirstPost', label: 'Published first post' },
];

export function Funnel({ counts }: { counts: FunnelCounts }) {
  const max = Math.max(...STAGES.map((s) => counts[s.key]), 1);

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 16 }}>
        Alpha funnel — last 30 days
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {STAGES.map((s, i) => {
          const value = counts[s.key];
          const widthPct = (value / max) * 100;
          const prev = i > 0 ? counts[STAGES[i - 1].key] : null;
          const convPct =
            prev !== null && prev > 0 ? Math.round((value / prev) * 100) : null;

          return (
            <div key={s.key}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  marginBottom: 4,
                  color: 'var(--sf-fg-2)',
                }}
              >
                <span>{s.label}</span>
                <span>
                  <strong style={{ color: 'var(--sf-fg-1)' }}>{value}</strong>
                  {convPct !== null ? (
                    <span style={{ marginLeft: 8, color: 'var(--sf-fg-3)' }}>
                      {convPct}%
                    </span>
                  ) : null}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: 'var(--sf-bg-3)',
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${widthPct}%`,
                    background: 'var(--sf-accent)',
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/admin/analytics/_queries/funnel.ts \
        src/app/\(app\)/admin/analytics/_queries/__tests__/funnel.test.ts \
        src/app/\(app\)/admin/analytics/_components/funnel.tsx \
        src/lib/test-utils/in-memory-db.ts
git commit -m "feat(analytics): add funnel query + component

5-stage alpha funnel — waitlist signups → approved → first sign-in
→ first scan → first post — over a 30-day window. Five aggregate
queries in parallel via Promise.all. Component renders styled-div
bars with conversion % vs. prior stage."
```

---

## Task 15: Daily activity query + spark-row component

**Files:**
- Create: `src/app/(app)/admin/analytics/_queries/daily.ts`
- Create: `src/app/(app)/admin/analytics/_queries/__tests__/daily.test.ts`
- Create: `src/app/(app)/admin/analytics/_components/spark-row.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/admin/analytics/_queries/__tests__/daily.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '@/lib/test-utils/in-memory-db';

let store: ReturnType<typeof createInMemoryStore>;
vi.mock('@/lib/db', () => ({
  get db() {
    return store.db;
  },
}));

import { getDailyActivity } from '../daily';

const NOW = new Date('2026-05-11T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86400_000);

describe('getDailyActivity', () => {
  beforeEach(() => {
    store = createInMemoryStore();
  });

  it('returns a 30-element bucket array per metric, oldest first', async () => {
    const r = await getDailyActivity({ now: NOW, windowDays: 30 });
    expect(r.waitlistSignups).toHaveLength(30);
    expect(r.signins).toHaveLength(30);
    expect(r.scans).toHaveLength(30);
    expect(r.drafts).toHaveLength(30);
    expect(r.postsPublished).toHaveLength(30);
    expect(r.approvals).toHaveLength(30);
  });

  it('buckets waitlist signups by calendar day', async () => {
    store.waitlistSignups.push(
      { id: 'w1', email: 'a@x', createdAt: ago(2), approvedAt: null, dismissedAt: null } as never,
      { id: 'w2', email: 'b@x', createdAt: ago(2), approvedAt: null, dismissedAt: null } as never,
      { id: 'w3', email: 'c@x', createdAt: ago(5), approvedAt: null, dismissedAt: null } as never,
    );
    const r = await getDailyActivity({ now: NOW, windowDays: 30 });
    // Day-2-ago is at index 30 - 2 - 1 = 27 (0-indexed, oldest first)
    expect(r.waitlistSignups[27]).toBe(2);
    expect(r.waitlistSignups[24]).toBe(1);
  });

  // Add similar tests for signins, scans, drafts, postsPublished, approvals
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/daily.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

Create `src/app/(app)/admin/analytics/_queries/daily.ts`:

```ts
import { sql, and, gte, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  waitlistSignups,
  users,
  pipelineEvents,
  drafts,
  posts,
} from '@/lib/db/schema';

export interface DailyActivity {
  /** Oldest-first day buckets, length = windowDays. */
  days: string[]; // ISO yyyy-mm-dd
  waitlistSignups: number[];
  signins: number[];
  scans: number[];
  drafts: number[];
  postsPublished: number[];
  approvals: number[];
}

export async function getDailyActivity(
  opts: { now?: Date; windowDays?: number } = {},
): Promise<DailyActivity> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);

  // Generate the day buckets in JS so empty days still appear as 0.
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    days.push(d.toISOString().slice(0, 10));
  }

  // For each metric, get { day, count } rows from PG via date_trunc,
  // then zip into the days array.
  const [waitlistRows, signinRows, scanRows, draftRows, postRows, approvalRows] =
    await Promise.all([
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${waitlistSignups.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(waitlistSignups)
        .where(gte(waitlistSignups.createdAt, since))
        .groupBy(sql`date_trunc('day', ${waitlistSignups.createdAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${users.lastLoginAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(users)
        .where(and(isNotNull(users.lastLoginAt), gte(users.lastLoginAt, since)))
        .groupBy(sql`date_trunc('day', ${users.lastLoginAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${pipelineEvents.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(pipelineEvents)
        .where(
          and(
            eq(pipelineEvents.stage, 'discovered'),
            gte(pipelineEvents.createdAt, since),
          ),
        )
        .groupBy(sql`date_trunc('day', ${pipelineEvents.createdAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${drafts.createdAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(drafts)
        .where(gte(drafts.createdAt, since))
        .groupBy(sql`date_trunc('day', ${drafts.createdAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${posts.postedAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(posts)
        .where(and(eq(posts.status, 'posted'), gte(posts.postedAt, since)))
        .groupBy(sql`date_trunc('day', ${posts.postedAt})`),
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${waitlistSignups.approvedAt}), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(waitlistSignups)
        .where(
          and(
            isNotNull(waitlistSignups.approvedAt),
            gte(waitlistSignups.approvedAt, since),
          ),
        )
        .groupBy(sql`date_trunc('day', ${waitlistSignups.approvedAt})`),
    ]);

  function zip(rows: Array<{ day: string; count: number }>): number[] {
    const m = new Map(rows.map((r) => [r.day, Number(r.count)]));
    return days.map((d) => m.get(d) ?? 0);
  }

  return {
    days,
    waitlistSignups: zip(waitlistRows),
    signins: zip(signinRows),
    scans: zip(scanRows),
    drafts: zip(draftRows),
    postsPublished: zip(postRows),
    approvals: zip(approvalRows),
  };
}
```

- [ ] **Step 4: Write the spark-row component**

Create `src/app/(app)/admin/analytics/_components/spark-row.tsx`:

```tsx
import { Sparkline } from '@/components/admin/sparkline';
import type { DailyActivity } from '../_queries/daily';

const METRICS: Array<{ key: keyof Omit<DailyActivity, 'days'>; label: string }> = [
  { key: 'waitlistSignups', label: 'Signups' },
  { key: 'signins', label: 'Sign-ins' },
  { key: 'scans', label: 'Scans' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'postsPublished', label: 'Published' },
  { key: 'approvals', label: 'Approvals' },
];

export function SparkRow({ daily }: { daily: DailyActivity }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 16px' }}>
        Daily activity — last 30 days
      </h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: 12,
        }}
      >
        {METRICS.map((m) => {
          const values = daily[m.key];
          const today = values[values.length - 1] ?? 0;
          const total = values.reduce((a, b) => a + b, 0);
          return (
            <div
              key={m.key}
              style={{
                padding: 12,
                background: 'var(--sf-bg-2)',
                borderRadius: 6,
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{m.label}</div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  margin: '4px 0 6px',
                }}
              >
                <span style={{ fontSize: 18, fontWeight: 600 }}>{today}</span>
                <span style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{total} 30d</span>
              </div>
              <Sparkline values={values} width={120} height={20} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests + commit**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/daily.test.ts
git add src/app/\(app\)/admin/analytics/_queries/daily.ts \
        src/app/\(app\)/admin/analytics/_queries/__tests__/daily.test.ts \
        src/app/\(app\)/admin/analytics/_components/spark-row.tsx
git commit -m "feat(analytics): add daily-activity query + spark-row

6 metrics bucketed by day over a 30-day window. Empty days zero-filled
in JS so sparklines have consistent length. Each metric renders today's
count + 30d total + a tiny inline-SVG sparkline."
```

---

## Task 16: Retention query + component

**Files:**
- Create: `src/app/(app)/admin/analytics/_queries/retention.ts`
- Create: `src/app/(app)/admin/analytics/_queries/__tests__/retention.test.ts`
- Create: `src/app/(app)/admin/analytics/_components/retention.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/admin/analytics/_queries/__tests__/retention.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '@/lib/test-utils/in-memory-db';

let store: ReturnType<typeof createInMemoryStore>;
vi.mock('@/lib/db', () => ({
  get db() {
    return store.db;
  },
}));

import { getRetention } from '../retention';

const NOW = new Date('2026-05-11T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86400_000);

describe('getRetention', () => {
  beforeEach(() => {
    store = createInMemoryStore();
  });

  it('returns cohorts oldest-first', async () => {
    store.users.push(
      { id: 'u1', email: 'a@x', createdAt: ago(28) } as never,
      { id: 'u2', email: 'b@x', createdAt: ago(7) } as never,
    );
    const r = await getRetention({ now: NOW, windowDays: 30 });
    expect(r.cohorts[0].cohortStart < r.cohorts[r.cohorts.length - 1].cohortStart).toBe(true);
  });

  it('counts a user as retained in week N if they took a meaningful action in that week', async () => {
    store.users.push({ id: 'u1', email: 'a@x', createdAt: ago(21) } as never);
    // Action 14 days ago — should retain in W1 (7-13d after signup)
    store.posts.push(
      { id: 'p1', userId: 'u1', status: 'posted', postedAt: ago(14) } as never,
    );
    const r = await getRetention({ now: NOW, windowDays: 30 });
    const cohort = r.cohorts.find((c) => c.cohortSize === 1);
    expect(cohort).toBeDefined();
    expect(cohort!.weeklyRetention[1]).toBe(1);
  });

  it('computes D1 / D7 / D14 retention', async () => {
    store.users.push({ id: 'u1', email: 'a@x', createdAt: ago(20) } as never);
    store.posts.push(
      { id: 'p1', userId: 'u1', status: 'posted', postedAt: ago(15) } as never,
    );
    const r = await getRetention({ now: NOW, windowDays: 30 });
    expect(r.nDayRetention.d7).toBeGreaterThan(0);
    expect(r.nDayRetention.d14).toBeGreaterThanOrEqual(0);
  });

  it('returns dauWauRatio as DAU/WAU', async () => {
    // 7 distinct users with actions in last 7 days
    for (let i = 0; i < 7; i++) {
      store.posts.push({
        id: `p${i}`,
        userId: `u${i}`,
        status: 'posted',
        postedAt: ago(i),
      } as never);
    }
    const r = await getRetention({ now: NOW, windowDays: 30 });
    expect(r.dauWauRatio).toBeGreaterThan(0);
    expect(r.dauWauRatio).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/retention.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

Create `src/app/(app)/admin/analytics/_queries/retention.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

export interface CohortRow {
  cohortStart: string; // yyyy-mm-dd of week start
  cohortSize: number;
  // Index N = retention in week N (W0 = signup week, W1 = 7-13 days after, etc.)
  weeklyRetention: number[]; // counts of returning users, not percentages
}

export interface RetentionResult {
  cohorts: CohortRow[];
  nDayRetention: { d1: number; d7: number; d14: number }; // 0..1
  dauWauRatio: number; // 0..1
}

/**
 * Retention based on "meaningful action" = scan, draft, OR post.
 *
 *   meaningful_action_days = SELECT DISTINCT user_id, date_trunc('day', t)::date AS day
 *     FROM (
 *       SELECT user_id, created_at AS t FROM pipeline_events WHERE stage='discovered'
 *       UNION ALL
 *       SELECT user_id, created_at AS t FROM drafts
 *       UNION ALL
 *       SELECT user_id, posted_at AS t FROM posts WHERE status='posted' AND posted_at IS NOT NULL
 *     ) x;
 *
 * Cohorts are weekly buckets starting from windowDays days ago.
 */
export async function getRetention(
  opts: { now?: Date; windowDays?: number } = {},
): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);

  // The CTE is reused 3 times → declare via a SQL fragment.
  const actionsCte = sql`
    WITH meaningful_action_days AS (
      SELECT user_id, date_trunc('day', t)::date AS day FROM (
        SELECT user_id, created_at AS t FROM pipeline_events
          WHERE stage = 'discovered'
        UNION ALL
        SELECT user_id, created_at AS t FROM drafts
        UNION ALL
        SELECT user_id, posted_at AS t FROM posts
          WHERE status = 'posted' AND posted_at IS NOT NULL
      ) x
      GROUP BY user_id, date_trunc('day', t)::date
    )
  `;

  // Cohort retention: for each weekly cohort starting in the window,
  // count distinct users active in each week-offset (W0..W3).
  const cohortRows = (await db.execute(sql`
    ${actionsCte},
    cohorts AS (
      SELECT
        date_trunc('week', created_at)::date AS cohort_start,
        id AS user_id
      FROM users
      WHERE created_at >= ${since.toISOString()}::timestamptz
    )
    SELECT
      c.cohort_start,
      count(DISTINCT c.user_id)::int AS cohort_size,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 0 AND 6 THEN m.user_id END)::int AS w0,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 7 AND 13 THEN m.user_id END)::int AS w1,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 14 AND 20 THEN m.user_id END)::int AS w2,
      count(DISTINCT CASE
        WHEN m.day - c.cohort_start BETWEEN 21 AND 27 THEN m.user_id END)::int AS w3
    FROM cohorts c
    LEFT JOIN meaningful_action_days m USING (user_id)
    GROUP BY c.cohort_start
    ORDER BY c.cohort_start ASC
  `)) as unknown as Array<{
    cohort_start: string;
    cohort_size: number;
    w0: number;
    w1: number;
    w2: number;
    w3: number;
  }>;

  const cohorts: CohortRow[] = cohortRows.map((r) => ({
    cohortStart: r.cohort_start,
    cohortSize: Number(r.cohort_size),
    weeklyRetention: [r.w0, r.w1, r.w2, r.w3].map(Number),
  }));

  // N-day retention: of users who signed up at least N days ago,
  // what fraction had a meaningful action by day N?
  const nDayRows = (await db.execute(sql`
    ${actionsCte},
    eligible AS (
      SELECT id, created_at
      FROM users
      WHERE created_at >= ${since.toISOString()}::timestamptz
    )
    SELECT
      sum(CASE WHEN now() - e.created_at >= interval '1 day' THEN 1 ELSE 0 END)::int AS e_d1,
      sum(CASE WHEN now() - e.created_at >= interval '1 day' AND EXISTS (
        SELECT 1 FROM meaningful_action_days m
        WHERE m.user_id = e.id AND m.day - e.created_at::date <= 1
      ) THEN 1 ELSE 0 END)::int AS r_d1,

      sum(CASE WHEN now() - e.created_at >= interval '7 days' THEN 1 ELSE 0 END)::int AS e_d7,
      sum(CASE WHEN now() - e.created_at >= interval '7 days' AND EXISTS (
        SELECT 1 FROM meaningful_action_days m
        WHERE m.user_id = e.id AND m.day - e.created_at::date <= 7
      ) THEN 1 ELSE 0 END)::int AS r_d7,

      sum(CASE WHEN now() - e.created_at >= interval '14 days' THEN 1 ELSE 0 END)::int AS e_d14,
      sum(CASE WHEN now() - e.created_at >= interval '14 days' AND EXISTS (
        SELECT 1 FROM meaningful_action_days m
        WHERE m.user_id = e.id AND m.day - e.created_at::date <= 14
      ) THEN 1 ELSE 0 END)::int AS r_d14
    FROM eligible e
  `)) as unknown as Array<{
    e_d1: number; r_d1: number;
    e_d7: number; r_d7: number;
    e_d14: number; r_d14: number;
  }>;

  const n = nDayRows[0] ?? { e_d1: 0, r_d1: 0, e_d7: 0, r_d7: 0, e_d14: 0, r_d14: 0 };
  const nDayRetention = {
    d1: n.e_d1 > 0 ? n.r_d1 / n.e_d1 : 0,
    d7: n.e_d7 > 0 ? n.r_d7 / n.e_d7 : 0,
    d14: n.e_d14 > 0 ? n.r_d14 / n.e_d14 : 0,
  };

  // DAU/WAU: distinct active users last 1d / distinct active users last 7d.
  const dauWauRow = (await db.execute(sql`
    ${actionsCte}
    SELECT
      count(DISTINCT CASE WHEN day >= (now() - interval '1 day')::date THEN user_id END)::int AS dau,
      count(DISTINCT CASE WHEN day >= (now() - interval '7 days')::date THEN user_id END)::int AS wau
    FROM meaningful_action_days
  `)) as unknown as Array<{ dau: number; wau: number }>;
  const { dau, wau } = dauWauRow[0] ?? { dau: 0, wau: 0 };
  const dauWauRatio = wau > 0 ? dau / wau : 0;

  return { cohorts, nDayRetention, dauWauRatio };
}
```

**Note on testing:** The CTE-heavy SQL requires real Postgres semantics. The in-memory store can't fake `date_trunc` and `LEFT JOIN ... USING`. Mark the retention tests as Postgres-required:

```ts
// At top of retention.test.ts:
const REAL_DB = process.env.TEST_REAL_DB === '1';
describe.skipIf(!REAL_DB)('getRetention', () => { ... });
```

Then run with a real test DB:
```bash
TEST_REAL_DB=1 DATABASE_URL=$TEST_DATABASE_URL pnpm vitest run \
  src/app/\(app\)/admin/analytics/_queries/__tests__/retention.test.ts
```

If no `TEST_DATABASE_URL` is available, the tests skip silently and the contract is verified by the manual smoke run in Step 5.

- [ ] **Step 4: Write the component**

Create `src/app/(app)/admin/analytics/_components/retention.tsx`:

```tsx
import type { RetentionResult } from '../_queries/retention';

export function Retention({ data }: { data: RetentionResult }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 16px' }}>
        Retention — meaningful actions per cohort
      </h3>

      {/* D1 / D7 / D14 + Stickiness */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 24,
        }}
      >
        <BigStat label="D1" value={pct(data.nDayRetention.d1)} />
        <BigStat label="D7" value={pct(data.nDayRetention.d7)} />
        <BigStat label="D14" value={pct(data.nDayRetention.d14)} />
        <BigStat
          label="DAU/WAU"
          value={data.dauWauRatio.toFixed(2)}
          caption={
            data.dauWauRatio > 0.5 ? 'sticky'
              : data.dauWauRatio > 0.2 ? 'forming'
              : 'low engagement'
          }
        />
      </div>

      {/* Cohort table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--sf-fg-3)' }}>
            <th style={th}>Cohort</th>
            <th style={th}>Size</th>
            <th style={th}>W0</th>
            <th style={th}>W1</th>
            <th style={th}>W2</th>
            <th style={th}>W3</th>
          </tr>
        </thead>
        <tbody>
          {data.cohorts.map((c) => (
            <tr key={c.cohortStart} style={{ borderTop: '1px solid var(--sf-border-1)' }}>
              <td style={td}>{c.cohortStart}</td>
              <td style={td}>{c.cohortSize}</td>
              {[0, 1, 2, 3].map((wi) => {
                const count = c.weeklyRetention[wi] ?? 0;
                const ratio = c.cohortSize > 0 ? count / c.cohortSize : 0;
                return (
                  <td
                    key={wi}
                    style={{
                      ...td,
                      background: `rgba(0, 150, 200, ${ratio * 0.5})`,
                    }}
                  >
                    {c.cohortSize > 0 ? `${Math.round(ratio * 100)}%` : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BigStat({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div style={{ padding: 12, background: 'var(--sf-bg-2)', borderRadius: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, margin: '2px 0' }}>{value}</div>
      {caption ? (
        <div style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{caption}</div>
      ) : null}
    </div>
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', fontWeight: 500 };
const td: React.CSSProperties = { padding: '6px 8px' };
```

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/admin/analytics/_queries/retention.ts \
        src/app/\(app\)/admin/analytics/_queries/__tests__/retention.test.ts \
        src/app/\(app\)/admin/analytics/_components/retention.tsx
git commit -m "feat(analytics): add weekly cohort retention + N-day + DAU/WAU

Single SQL with a meaningful-action CTE: scan ∪ draft ∪ post-published.
Cohort triangle (W0..W3) for each weekly signup cohort. D1/D7/D14
absolute retention. DAU/WAU stickiness ratio with one-word caption.
Tests are Postgres-required (CTE + LEFT JOIN USING) — skip when
TEST_REAL_DB unset."
```

---

## Task 17: Per-user table query + component

**Files:**
- Create: `src/app/(app)/admin/analytics/_queries/users.ts`
- Create: `src/app/(app)/admin/analytics/_queries/__tests__/users.test.ts`
- Create: `src/app/(app)/admin/analytics/_components/user-table.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/admin/analytics/_queries/__tests__/users.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryStore } from '@/lib/test-utils/in-memory-db';

let store: ReturnType<typeof createInMemoryStore>;
vi.mock('@/lib/db', () => ({
  get db() {
    return store.db;
  },
}));

import { getActiveUsers } from '../users';

const NOW = new Date('2026-05-11T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86400_000);

describe('getActiveUsers', () => {
  beforeEach(() => {
    store = createInMemoryStore();
  });

  it('returns only users with signup or activity in the last windowDays', async () => {
    store.users.push(
      { id: 'u1', email: 'a@x', createdAt: ago(5), lastLoginAt: ago(2) } as never,
      { id: 'u2', email: 'b@x', createdAt: ago(45), lastLoginAt: ago(40) } as never,
    );
    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    expect(rows.map((r) => r.email)).toEqual(['a@x']);
  });

  it('classifies status by activity recency', async () => {
    // u1 = active (post in 7d)
    store.users.push({ id: 'u1', email: 'a@x', createdAt: ago(10), lastLoginAt: ago(1) } as never);
    store.posts.push({ id: 'p1', userId: 'u1', status: 'posted', postedAt: ago(2) } as never);

    // u2 = dormant (signin in 7d but no action)
    store.users.push({ id: 'u2', email: 'b@x', createdAt: ago(15), lastLoginAt: ago(3) } as never);

    // u3 = lost (no signin in 14d)
    store.users.push({ id: 'u3', email: 'c@x', createdAt: ago(28), lastLoginAt: ago(20) } as never);

    const rows = await getActiveUsers({ now: NOW, windowDays: 30 });
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.status]));
    expect(byEmail['a@x']).toBe('active');
    expect(byEmail['b@x']).toBe('dormant');
    expect(byEmail['c@x']).toBe('lost');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/users.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the query**

Create `src/app/(app)/admin/analytics/_queries/users.ts`:

```ts
import { sql, gte, or, isNotNull, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getPartnerActivityCounts } from '@/lib/admin/partner-activity';

export interface UserRow {
  userId: string;
  email: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  scans7d: number;
  drafts7d: number;
  posts7d: number;
  status: 'active' | 'dormant' | 'lost';
}

export async function getActiveUsers(
  opts: { now?: Date; windowDays?: number } = {},
): Promise<UserRow[]> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);
  const day7 = new Date(now.getTime() - 7 * 86400_000);
  const day14 = new Date(now.getTime() - 14 * 86400_000);

  // Users who signed up or logged in within the window
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(or(gte(users.createdAt, since), gte(users.lastLoginAt, since)))
    .orderBy(desc(users.lastLoginAt));

  const counts = await getPartnerActivityCounts(rows.map((r) => r.userId));

  return rows.map((r) => {
    const c = counts[r.userId] ?? { scans: 0, drafts: 0, posts: 0 };
    const hasAction = c.scans > 0 || c.drafts > 0 || c.posts > 0;
    const signedInRecently =
      r.lastLoginAt != null && r.lastLoginAt.getTime() >= day7.getTime();
    const signedInWithin14d =
      r.lastLoginAt != null && r.lastLoginAt.getTime() >= day14.getTime();

    let status: 'active' | 'dormant' | 'lost';
    if (hasAction) status = 'active';
    else if (signedInRecently) status = 'dormant';
    else if (!signedInWithin14d) status = 'lost';
    else status = 'dormant';

    return {
      userId: r.userId,
      email: r.email ?? '(no email)',
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
      scans7d: c.scans,
      drafts7d: c.drafts,
      posts7d: c.posts,
      status,
    };
  });
}
```

**Important:** Verify that `getPartnerActivityCounts` returns counts keyed by `userId` matching the expected shape `{ scans, drafts, posts }`. If the existing function returns a different shape, either adapt the call site or extend the helper. Inspect `src/lib/admin/partner-activity.ts` before relying on the exact return type.

- [ ] **Step 4: Write the component**

Create `src/app/(app)/admin/analytics/_components/user-table.tsx`:

```tsx
import type { UserRow } from '../_queries/users';

const STATUS_STYLE: Record<UserRow['status'], React.CSSProperties> = {
  active: { background: '#1f7a3a', color: '#fff' },
  dormant: { background: '#9a7a1f', color: '#fff' },
  lost: { background: '#7a1f1f', color: '#fff' },
};

const STATUS_LABEL: Record<UserRow['status'], string> = {
  active: '🟢 active',
  dormant: '🟡 dormant',
  lost: '🔴 lost',
};

export function UserTable({ rows }: { rows: UserRow[] }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 16px' }}>
        Users — last 30 days
      </h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--sf-fg-3)' }}>
            <th style={th}>Email</th>
            <th style={th}>Signed up</th>
            <th style={th}>Last seen</th>
            <th style={{ ...th, textAlign: 'right' }}>Scans 7d</th>
            <th style={{ ...th, textAlign: 'right' }}>Drafts 7d</th>
            <th style={{ ...th, textAlign: 'right' }}>Posts 7d</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} style={{ borderTop: '1px solid var(--sf-border-1)' }}>
              <td style={td}>{r.email}</td>
              <td style={td}>{r.createdAt.toLocaleDateString()}</td>
              <td style={td}>
                {r.lastLoginAt ? r.lastLoginAt.toLocaleDateString() : '—'}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{r.scans7d}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.drafts7d}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.posts7d}</td>
              <td style={td}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    ...STATUS_STYLE[r.status],
                  }}
                >
                  {STATUS_LABEL[r.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: '6px 8px' };
```

- [ ] **Step 5: Run tests + commit**

```bash
pnpm vitest run src/app/\(app\)/admin/analytics/_queries/__tests__/users.test.ts
git add src/app/\(app\)/admin/analytics/_queries/users.ts \
        src/app/\(app\)/admin/analytics/_queries/__tests__/users.test.ts \
        src/app/\(app\)/admin/analytics/_components/user-table.tsx
git commit -m "feat(analytics): add per-user table

Reuses getPartnerActivityCounts for 7d activity. Status classification:
active = any meaningful action in 7d, dormant = signed in but no action
in 7d, lost = no signin in 14d. Default sort by last seen desc."
```

---

## Task 18: Analytics page composition + admin nav link

**Files:**
- Create: `src/app/(app)/admin/analytics/page.tsx`
- Modify: `src/app/(app)/admin/page.tsx`

- [ ] **Step 1: Compose the analytics page**

Create `src/app/(app)/admin/analytics/page.tsx`:

```tsx
import { getFunnel } from './_queries/funnel';
import { getRetention } from './_queries/retention';
import { getDailyActivity } from './_queries/daily';
import { getActiveUsers } from './_queries/users';
import { Funnel } from './_components/funnel';
import { Retention } from './_components/retention';
import { SparkRow } from './_components/spark-row';
import { UserTable } from './_components/user-table';

export const revalidate = 60; // 1-minute ISR

export default async function AdminAnalyticsPage() {
  const [funnel, retention, daily, userRows] = await Promise.all([
    getFunnel(),
    getRetention(),
    getDailyActivity(),
    getActiveUsers(),
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
      <Funnel counts={funnel} />
      <Retention data={retention} />
      <SparkRow daily={daily} />
      <UserTable rows={userRows} />
    </div>
  );
}

export const metadata = {
  title: 'Analytics — ShipFlare admin',
};
```

- [ ] **Step 2: Add analytics to the admin index nav**

Open `src/app/(app)/admin/page.tsx`. Find the `TOOLS` array and append:

```ts
const TOOLS: Array<{ href: string; title: string; blurb: string }> = [
  {
    href: '/admin/invites',
    title: 'Design partner invites',
    blurb:
      'Manage allowlisted emails and per-partner activity. Add or revoke invites, see who has actually signed up.',
  },
  {
    href: '/admin/analytics',
    title: 'Analytics',
    blurb:
      'Alpha funnel, weekly cohort retention, daily activity, and per-user health for the last 30 days.',
  },
  {
    href: '/admin/team-runs',
    title: 'Team runs',
    blurb:
      'Read-only history of every team_run across the system. Filter by status, team, cost, or window.',
  },
];
```

- [ ] **Step 3: Verify the page builds and renders**

```bash
pnpm tsc --noEmit
pnpm dev
```

Sign in as `SUPER_ADMIN_EMAIL`, navigate to:
- `http://localhost:3000/admin` — verify the new "Analytics" tile appears
- `http://localhost:3000/admin/analytics` — verify the page renders all four sections (funnel, retention, daily, user table) with current data

Expected: page loads, all sections render. With an empty alpha, most numbers will be zero — that's fine, the structure is what we're verifying.

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
pnpm tsc --noEmit
pnpm build
```

Expected: all green; tsc exit 0; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/admin/analytics/page.tsx \
        src/app/\(app\)/admin/page.tsx
git commit -m "feat(analytics): /admin/analytics page

4 sections in order: funnel, retention, daily sparklines, per-user
table. All 4 queries in parallel via Promise.all. 1-minute ISR via
revalidate=60. Admin index gains a tile linking here."
```

- [ ] **Step 6: Push and PR for Phase 2**

```bash
git push origin dev
gh pr create --title "Admin analytics page (Phase 2)" --body "$(cat <<'EOF'
## Summary
- New /admin/analytics page with 4 sections:
  - Alpha funnel: waitlist → approved → first signup → first scan → first post
  - Retention: weekly cohort table + D1/D7/D14 + DAU/WAU stickiness
  - Daily activity: 6 sparklines (signups, signins, scans, drafts, posts, approvals)
  - Per-user table: 7d activity + active/dormant/lost status
- Pure read views over existing tables — no new tracking infra
- All queries in parallel via Promise.all; 1-minute ISR via revalidate=60
- Added to /admin index nav

## Test plan
- [ ] pnpm test green
- [ ] pnpm tsc --noEmit exit 0
- [ ] pnpm build succeeds
- [ ] Page renders for SUPER_ADMIN_EMAIL
- [ ] Non-admin gets 404 (existing admin layout gate)
- [ ] Retention CTE tests pass against real Postgres (TEST_REAL_DB=1)

Spec: docs/superpowers/specs/2026-05-11-alpha-gate-and-waitlist-design.md
EOF
)"
```

---

## Final Self-Review

Before delivering this plan, the writing-plans skill runs a self-review on each task against the spec.

**Spec coverage:**
- §1 Allowlist gate — Task 5 ✓
- §2 Data model — Task 1 ✓
- §3 Waitlist page — Task 7 ✓
- §4 joinWaitlist action — Task 6 ✓
- §5 Email infra — Tasks 3 & 4 ✓
- §6 Landing page updates — Task 8 ✓
- §7 Admin waitlist tab — Task 9 ✓
- §8A Funnel — Task 14 ✓
- §8B Daily sparks — Task 15 ✓
- §8C Per-user table — Task 17 ✓
- §8D Retention — Task 16 ✓
- §9 Testing — covered per-task with unit tests + Task 11 E2E ✓
- §10 Security — addressed in Task 6 (honeypot, rate limit, IP hash) and Task 7 (XSS guard on pre-fill) ✓
- §11 Env vars + migration — Task 1 (migration), Task 10 (env example) ✓
- §12 Rollout — Phase 1 = Tasks 1–12 (PR via Task 12 step 3); Phase 2 = Tasks 13–18 ✓

**Placeholder scan:** no "TBD" / "fill in later" / "similar to Task N". Every code step contains executable code. Pre-existing patterns (e.g., the original invites table markup in Task 9 step 6) are explicitly directed to be copied verbatim from the named source file rather than vaguely "follow the same pattern".

**Type consistency:** `JoinWaitlistState`, `EmailPayload`, `FunnelCounts`, `DailyActivity`, `RetentionResult`, `CohortRow`, `UserRow`, `BannerVariant` are defined exactly once and consumed by name. `joinWaitlist`, `approveWaitlistSignup`, `dismissWaitlistSignup`, `sendEmail`, `hashIp`, `waitlistAdminNotification`, `waitlistApproved`, `Sparkline`, `Funnel`, `Retention`, `SparkRow`, `UserTable`, `WaitlistTab`, `WaitlistActionsButtons`, `ContextBanner`, `WaitlistForm`, `signInCallback`, `getFunnel`, `getRetention`, `getDailyActivity`, `getActiveUsers` — all symbol names match across declaration and call sites.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-11-alpha-gate-and-waitlist.md`.**

## Execution

Two options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, fast iteration. Per project memory `feedback_team_implementer_checkpoint_discipline`, this is the better fit for multi-phase plans because each task ends with a hard checkpoint where the parent reviews diffs before unblocking the next subagent.
2. **Inline Execution** — execute tasks in this session with batched checkpoints.

**Which approach?**
