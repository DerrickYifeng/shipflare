# Railway → Cloudflare Frontend Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Railway's 5 logged-in pages (`/briefing`, `/team`, `/product`, `/growth`, `/settings`) + landing onto `apps/web` while preserving Apple-gallery visual style and keeping the CF backend (CMO + HoG + SMM Durable Objects) intact.

**Architecture:** Hybrid data layer — D1 for founder-owned profile + observed metrics (`products`, `user_preferences`, `growth_snapshots`); per-DO SQLite stays the source of truth for agent-internal state (plan items, drafts, conversations). Wholesale-copy Railway's `src/components/` tree into `apps/web/src/components/`. Six independent slices in this order: Landing → Settings → Product → Briefing → Team → Growth.

**Tech Stack:** Next.js 16 (App Router) on Cloudflare Workers via OpenNext, Better Auth (GitHub + Google), Drizzle ORM on D1, Cloudflare Durable Objects (Agents SDK) for agents, SWR for client data, Playwright for real-browser smoke tests, Vitest + `@cloudflare/vitest-pool-workers` for unit tests.

**Reference spec:** [`docs/superpowers/specs/2026-05-14-railway-to-cf-frontend-migration-design.md`](../specs/2026-05-14-railway-to-cf-frontend-migration-design.md)

---

## File Structure

### New files (creates)

```
packages/db/migrations/
  002_user_preferences.sql          (Slice 2)
  003_products.sql                  (Slice 3)
  004_growth_snapshots.sql          (Slice 6)

packages/skills/skills/
  allocating-plan-items/SKILL.md    (Slice 5)

apps/web/src/
  lib/drizzle.ts                    (Slice 2) — D1 client + product/prefs/growth helpers
  lib/cmo-client.ts                 (Slice 2; extended in 4/5) — MCP wrapper
  components/marketing/*            (Slice 1) — wholesale copy from src/components/marketing
  components/layout/*               (Slice 2) — wholesale copy
  components/ui/*                   (Slice 2) — wholesale copy
  components/product/*              (Slice 3) — selective copy
  components/today/*                (Slice 4) — selective copy
  components/team/*                 (Slice 5) — selective copy
  components/growth/*               (Slice 6) — selective copy
  hooks/useTheme.ts                 (Slice 2)
  hooks/usePreferences.ts           (Slice 2)
  hooks/useTeamEvents.ts            (Slice 5)
  utils/resolveNavLabel.ts          (Slice 2)
  utils/derivePhase.ts              (Slice 3)
  utils/formatters.ts               (Slice 2)

apps/web/app/
  (app)/layout.tsx                  (Slice 2) — full shell port (replaces existing minimal one)
  (app)/settings/page.tsx           (Slice 2)
  (app)/settings/settings-content.tsx
  (app)/product/page.tsx            (Slice 3)
  (app)/product/product-content.tsx
  (app)/product/_components/editable-value.tsx
  (app)/briefing/page.tsx           (Slice 4)
  (app)/briefing/_components/today-tab.tsx
  (app)/team/page.tsx               (Slice 5) — replaces existing stub
  (app)/team/_components/team-desk.tsx
  (app)/team/_components/{left-rail,conversation,status-banner,sticky-composer}.tsx
  (app)/growth/page.tsx             (Slice 6)
  (app)/growth/growth-content.tsx
  (app)/growth/_components/{overall-hero,social-panel,channel-card}.tsx
  api/preferences/route.ts          (Slice 2)
  api/product/route.ts              (Slice 3)
  api/growth/overview/route.ts      (Slice 6)
```

### Modified files

```
apps/web/app/page.tsx               (Slice 1) — replace with ported landing
apps/web/app/_components/sign-in-button.tsx  (Slice 1) — provider param, default /briefing
apps/web/src/auth.ts                (Slice 1) — add google provider
apps/web/wrangler.jsonc             (Slice 1+6) — secrets; slice 6 cron extension
apps/web/app/_components/...        — extend if needed
apps/core/wrangler.jsonc            (Slice 6) — cron handler if not already wired
apps/core/src/index.ts              (Slice 6) — cron-tick growth snapshot fan-out
packages/db/src/schema.ts           (Slice 2,3,6) — add 3 tables
packages/skills/src/registry.ts     (Slice 5) — inline allocating-plan-items
apps/core/src/agents/cmo/CMO.ts     (Slice 5) — only if list_roster missing
```

### Deletes

```
apps/web/app/(app)/settings/channels/   (Slice 2 — folds into /settings)
apps/web/app/(app)/chat/                (Slice 4)
apps/web/app/(app)/plan/                (Slice 4)
apps/web/app/(app)/drafts/              (Slice 4)
apps/web/app/(app)/memory/              (Slice 5)
apps/web/app/(app)/mcp-urls/            (Slice 5)
apps/web/app/(app)/notifications/       (Slice 6)
```

---

## Slice 0 — Pre-flight

### Task 0.1: Verify environment and CMO roster tool

**Files:**
- Read: `apps/core/src/agents/cmo/tools/roster.ts`
- Read: `apps/core/src/agents/cmo/CMO.ts`

- [ ] **Step 1: Confirm `listRoster` tool exists on CMO**

```bash
grep -n "listRoster\|list_roster\|registerTool.*\"list" /Users/yifeng/Documents/Code/shipflare/apps/core/src/agents/cmo/tools/roster.ts
```

If you see `registerTool("listRoster"`, mark Task 5.3 as "skip — already exists" when you get to Slice 5. If not, Task 5.3 will add it.

- [ ] **Step 2: Confirm build baseline is green**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm install
pnpm -r exec tsc --noEmit
```

Expected: all packages typecheck. If failures exist that aren't yours, fix or note them — every later slice's done-criterion is "tsc green AND build green".

- [ ] **Step 3: Commit nothing — this is a verification task**

No commit. Move on.

---

## Slice 1 — Landing page + Google OAuth

### Task 1.1: Add Google to Better Auth config

**Files:**
- Modify: `apps/web/src/auth.ts`

- [ ] **Step 1: Add google provider block**

Open `apps/web/src/auth.ts`. Find the `socialProviders: { github: { … } }` block and replace it with:

```typescript
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
```

- [ ] **Step 2: Add the env types**

Open `apps/web/worker-configuration.d.ts`. Add `GOOGLE_CLIENT_ID: string;` and `GOOGLE_CLIENT_SECRET: string;` to the `Env` interface (or whatever shape it uses). If the file is auto-generated by `wrangler types`, run `pnpm wrangler types` after adding secrets in step 4.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

Expected: PASS (env types should resolve).

- [ ] **Step 4: Add the secrets locally**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
echo "GOOGLE_CLIENT_ID=your-id-here" >> .dev.vars
echo "GOOGLE_CLIENT_SECRET=your-secret-here" >> .dev.vars
```

Get values from https://console.cloud.google.com/apis/credentials. Authorized redirect URI on the Google OAuth client: `http://localhost:3000/api/auth/callback/google` for local + `https://shipflare.ai/api/auth/callback/google` for prod.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/auth.ts apps/web/worker-configuration.d.ts
git commit -m "feat(auth): add Google OAuth provider to Better Auth"
```

(Do NOT commit `.dev.vars` — it's in `.gitignore`.)

---

### Task 1.2: Extend SignInButton to accept provider

**Files:**
- Modify: `apps/web/app/_components/sign-in-button.tsx`

- [ ] **Step 1: Replace the component with multi-provider version**

Overwrite `apps/web/app/_components/sign-in-button.tsx` with:

```tsx
"use client";

import { authClient } from "@/auth-client";

interface SignInButtonProps {
  provider?: "github" | "google";
  callbackURL?: string;
  label?: string;
  variant?: "primary" | "secondary";
}

export function SignInButton({
  provider = "github",
  callbackURL = "/briefing",
  label,
  variant = "primary",
}: SignInButtonProps) {
  const defaultLabel = provider === "google" ? "Sign in with Google" : "Sign in with GitHub";
  const isPrimary = variant === "primary";
  return (
    <button
      type="button"
      onClick={() =>
        authClient.signIn.social({
          provider,
          callbackURL,
        })
      }
      className={isPrimary ? "sf-cta-primary" : "sf-cta-secondary"}
    >
      {label ?? defaultLabel}
    </button>
  );
}
```

- [ ] **Step 2: Add the CTA styles to globals.css**

Open `apps/web/app/globals.css` and append (before the closing of the file, after the existing utility blocks):

```css
.sf-cta-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 24px;
  background: var(--sf-accent);
  color: #ffffff;
  border: none;
  border-radius: var(--sf-radius-pill);
  font-family: var(--sf-font-text);
  font-size: 17px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--sf-dur-fast) var(--sf-ease);
}
.sf-cta-primary:hover { background: var(--sf-accent-hover); }

.sf-cta-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 24px;
  background: transparent;
  color: var(--sf-fg-1);
  border: 1px solid var(--sf-fg-3);
  border-radius: var(--sf-radius-pill);
  font-family: var(--sf-font-text);
  font-size: 17px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--sf-dur-fast) var(--sf-ease);
}
.sf-cta-secondary:hover { background: var(--sf-bg-primary); }
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/_components/sign-in-button.tsx apps/web/app/globals.css
git commit -m "feat(web): SignInButton accepts provider + variant, default callback /briefing"
```

---

### Task 1.3: Wholesale-copy marketing components from Railway

**Files:**
- Create: `apps/web/src/components/marketing/*`

- [ ] **Step 1: Copy the marketing tree verbatim**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/marketing
cp -R /Users/yifeng/Documents/Code/shipflare/src/components/marketing/* \
      /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/marketing/
```

- [ ] **Step 2: List what came across**

```bash
ls /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/marketing/
```

Expected: GlassNav, HeroDemo, HowItWorks, PhaseSection, ThreadsSection, SafetySection, VideoSection, Footer (plus any sub-trees they own).

- [ ] **Step 3: Fix import paths to use `@/` alias**

The Railway copies use `@/` imports too, but their `@` resolves to `src/`. On CF, `@` resolves to `apps/web/src/`. Confirm `tsconfig.json` `paths` mapping:

```bash
grep -A 3 '"paths"' /Users/yifeng/Documents/Code/shipflare/apps/web/tsconfig.json
```

Expected: `"@/*": ["./src/*"]` (or similar). If absent, add it.

Now find any non-`@/` relative imports that reach OUT of `apps/web/src/components/marketing/`:

```bash
grep -rn "from ['\"]\.\./\.\./\.\.\|from ['\"]\.\./\.\./hooks\|from ['\"]\.\./\.\./lib\|from ['\"]\.\./\.\./utils" \
  /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/marketing/
```

For each match, rewrite to `@/...`. Example:
- `from "../../hooks/use-reduced-motion"` → `from "@/hooks/useReducedMotion"`

Note: hooks aren't copied yet. If marketing references a hook (likely `use-reduced-motion`), copy that specific hook too:

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/src/hooks
cp /Users/yifeng/Documents/Code/shipflare/src/hooks/use-reduced-motion.ts \
   /Users/yifeng/Documents/Code/shipflare/apps/web/src/hooks/useReducedMotion.ts 2>/dev/null \
   || echo "use-reduced-motion not found at expected path; grep marketing for the actual import to identify it"
```

(Adjust filename if Railway uses kebab-case `use-reduced-motion.ts`.)

- [ ] **Step 4: Strip Node-only / NextAuth imports**

```bash
grep -rn "from ['\"]next-auth\|from ['\"]node:\|getServerSession" \
  /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/marketing/
```

For each match, replace with Better Auth equivalent or remove (marketing components shouldn't read sessions; if any do, refactor to a server component that fetches once and passes down as prop).

- [ ] **Step 5: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

Expected: PASS. If errors, fix one at a time — most will be missing peer imports (`@/components/ui/*` not yet copied). For Slice 1 only, copy any UI primitive the marketing tree uses (typically `Container`, `Section`):

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/ui
for f in $(grep -l "from ['\"]@/components/ui/" /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/marketing/*.tsx 2>/dev/null); do
  grep -oh "@/components/ui/[a-z-]*" "$f" | sort -u
done
```

For each name listed, copy that file from `src/components/ui/` to `apps/web/src/components/ui/`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/marketing apps/web/src/components/ui apps/web/src/hooks/useReducedMotion.ts apps/web/tsconfig.json
git commit -m "feat(web): port marketing components from Railway"
```

---

### Task 1.4: Replace landing page

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Read Railway's landing**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/app/page.tsx
```

- [ ] **Step 2: Port to apps/web/app/page.tsx**

Overwrite `apps/web/app/page.tsx` with Railway's content. Apply these adjustments during the copy:

1. Replace any `import { auth } from "@/lib/auth"` with `import { getAuth } from "@/auth"` (server-side session).
2. Replace `const session = await auth()` with `const session = await getAuth().api.getSession({ headers: await headers() })`.
3. Replace the sign-in `<a href>` (if present) with the `<SignInButton />` component from `@/_components/sign-in-button`.
4. Keep `export const dynamic = "force-dynamic";` at the top (avoid stale prerender).
5. If the file pulls in `SignInModal`, port that component too OR replace its trigger with two stacked `<SignInButton provider="github" />` + `<SignInButton provider="google" variant="secondary" />` buttons.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

Fix any remaining import errors by copying the specific dependency (e.g. `Container.tsx`).

- [ ] **Step 4: Local smoke**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev
```

In another terminal, open http://localhost:3000 and confirm:
- Hero copy renders ("The AI marketing team for solo founders")
- Two CTAs visible
- "Sign in with GitHub" → OAuth round-trip → lands on `/briefing` (will 404 until Slice 4; OK for now)
- "Sign in with Google" → OAuth round-trip → also lands on `/briefing`

Kill `pnpm dev`.

- [ ] **Step 5: Build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm build
```

Expected: PASS. If the bundle warns about size (>10MB compressed), dynamic-import marketing sections inside `page.tsx`:

```tsx
import dynamic from "next/dynamic";
const HowItWorks = dynamic(() => import("@/components/marketing/HowItWorks"), { ssr: true });
```

- [ ] **Step 6: Playwright real-browser smoke**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm playwright test --grep="landing"
```

If no test exists yet, create `e2e/landing.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("landing page renders hero and both CTAs", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByRole("button", { name: /github/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
});
```

Run again. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/page.tsx e2e/landing.spec.ts
git commit -m "feat(web): port Railway landing page; replace sign-in-only placeholder"
```

---

## Slice 2 — Settings + (app) shell

### Task 2.1: Add user_preferences table

**Files:**
- Create: `packages/db/migrations/002_user_preferences.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/002_user_preferences.sql`:

```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  theme TEXT NOT NULL DEFAULT 'light',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

- [ ] **Step 2: Add Drizzle schema**

In `packages/db/src/schema.ts`, append:

```typescript
export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("UTC"),
  theme: text("theme", { enum: ["light", "dark"] }).notNull().default("light"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;
```

Ensure these are re-exported from `packages/db/src/index.ts`:

```typescript
export { userPreferences, type UserPreferences, type NewUserPreferences } from "./schema";
```

- [ ] **Step 3: Apply migration locally**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm wrangler d1 migrations apply DB --local
```

Expected: "✅ Migrations applied successfully" with `002_user_preferences.sql` listed.

- [ ] **Step 4: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm -r exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/002_user_preferences.sql packages/db/src/schema.ts packages/db/src/index.ts
git commit -m "feat(db): add user_preferences table"
```

---

### Task 2.2: Wholesale-copy layout + ui + hooks

**Files:**
- Create: `apps/web/src/components/layout/*`
- Create: `apps/web/src/components/ui/*` (extend from Slice 1)
- Create: `apps/web/src/hooks/{useTheme,usePreferences}.ts`
- Create: `apps/web/src/utils/{resolveNavLabel,formatters}.ts`

- [ ] **Step 1: Copy layout components**

```bash
cp -R /Users/yifeng/Documents/Code/shipflare/src/components/layout/* \
      /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/layout/
```

- [ ] **Step 2: Copy ui components (anything new on top of Slice 1 partial copy)**

```bash
cp -Rn /Users/yifeng/Documents/Code/shipflare/src/components/ui/* \
       /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/ui/
```

(`-n` means "no overwrite" — preserves what Slice 1 already placed.)

- [ ] **Step 3: Copy hooks**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/src/hooks
cp /Users/yifeng/Documents/Code/shipflare/src/hooks/use-preferences.ts \
   /Users/yifeng/Documents/Code/shipflare/apps/web/src/hooks/usePreferences.ts
```

Find Railway's theme provider/hook (it lives in `src/components/layout/theme-provider.tsx` typically):

```bash
grep -l "ThemeProvider\|useTheme" /Users/yifeng/Documents/Code/shipflare/src/components/layout/*.tsx
```

That file came across in step 1. Confirm `useTheme` is exported from it.

- [ ] **Step 4: Copy utils**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/src/utils
# Find what shell needs:
grep -roh "@/utils/[a-zA-Z-]*" /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/layout/ | sort -u
```

For each name listed, copy the corresponding file from `src/utils/<name>.ts`. Common ones: `resolveNavLabel`, `formatters`, `cn` (classnames helper).

- [ ] **Step 5: Rewrite Postgres/NextAuth imports**

```bash
grep -rn "from ['\"]next-auth\|from ['\"]@/lib/db['\"]\|from ['\"]pg" \
  /Users/yifeng/Documents/Code/shipflare/apps/web/src/components/layout/ \
  /Users/yifeng/Documents/Code/shipflare/apps/web/src/hooks/
```

Replace each:
- `from "@/lib/db"` → `from "@/lib/drizzle"` (will be created Task 2.3)
- `from "next-auth/react"` → `from "@/auth-client"` (use `authClient.useSession()` instead of `useSession()`)
- `from "pg"` → remove; not applicable on D1

- [ ] **Step 6: Typecheck (will likely fail; that's OK)**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit 2>&1 | head -30
```

Errors are expected (Drizzle client not yet built, API routes not yet present). Triaging happens in next tasks.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/layout apps/web/src/components/ui apps/web/src/hooks apps/web/src/utils
git commit -m "feat(web): port layout/ui/hooks/utils from Railway (WIP — tsc not yet green)"
```

---

### Task 2.3: Build the D1 client + API routes for preferences

**Files:**
- Create: `apps/web/src/lib/drizzle.ts`
- Create: `apps/web/app/api/preferences/route.ts`

- [ ] **Step 1: Create the Drizzle client**

Write `apps/web/src/lib/drizzle.ts`:

```typescript
import { drizzle } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "@shipflare/db";

export function getDrizzle() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}

export type Drizzle = ReturnType<typeof getDrizzle>;
```

- [ ] **Step 2: Write the failing test for /api/preferences**

Create `apps/web/test/api-preferences.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

describe("/api/preferences", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM user_preferences");
  });

  it("GET returns defaults when no row exists", async () => {
    // Stub: signed-in user. Real test would seed a session; for now, expect 401.
    const res = await SELF.fetch("https://test/api/preferences");
    expect(res.status).toBe(401);
  });
});
```

(Full session-seeded test is heavy; this 401 check verifies the route is wired and gates on auth.)

- [ ] **Step 3: Run test, expect FAIL**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm vitest run test/api-preferences.test.ts
```

Expected: FAIL (route doesn't exist yet).

- [ ] **Step 4: Write the route**

Create `apps/web/app/api/preferences/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/auth";
import { getDrizzle } from "@/lib/drizzle";
import { userPreferences } from "@shipflare/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDrizzle();
  const row = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .get();

  return NextResponse.json({
    timezone: row?.timezone ?? "UTC",
    theme: row?.theme ?? "light",
  });
}

export async function PATCH(req: Request) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as { timezone?: string; theme?: "light" | "dark" };
  const db = getDrizzle();
  await db
    .insert(userPreferences)
    .values({
      userId: session.user.id,
      timezone: body.timezone ?? "UTC",
      theme: body.theme ?? "light",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.theme ? { theme: body.theme } : {}),
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run test, expect PASS**

```bash
pnpm vitest run test/api-preferences.test.ts
```

Expected: PASS (401 for no session is correct).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/drizzle.ts apps/web/app/api/preferences/route.ts apps/web/test/api-preferences.test.ts
git commit -m "feat(web): add /api/preferences (GET + PATCH) on D1"
```

---

### Task 2.4: Replace (app)/layout.tsx with full ported shell

**Files:**
- Modify: `apps/web/app/(app)/layout.tsx`

- [ ] **Step 1: Read Railway's shell**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/app/(app)/layout.tsx
```

- [ ] **Step 2: Port to CF**

Overwrite `apps/web/app/(app)/layout.tsx`. Apply edits during the copy:

1. Replace `import { auth } from "@/auth"` (NextAuth) → `import { getAuth } from "@/auth"` (Better Auth) + `import { headers } from "next/headers"`.
2. Replace `const session = await auth()` → `const session = await getAuth().api.getSession({ headers: await headers() })`.
3. Add `export const dynamic = "force-dynamic";` at the top.
4. Replace the auth-redirect: `if (!session?.user) redirect("/");`.
5. Pass `session.user` props down to `<Sidebar>` and `<TopNav>` exactly as Railway does.

The structure (paraphrased):

```tsx
export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SWRConfig } from "swr";
import { getAuth } from "@/auth";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ShellChromeProvider } from "@/components/layout/shell-chrome-provider";
import { ToastProvider } from "@/components/layout/toast-provider";
import { AppShell } from "@/components/layout/app-shell";
import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/top-nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/");
  const user = {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };

  return (
    <SWRConfig value={{ dedupingInterval: 5_000, focusThrottleInterval: 10_000, revalidateOnFocus: false }}>
      <ThemeProvider>
        <ShellChromeProvider>
          <ToastProvider>
            <AppShell sidebar={<Sidebar user={user} />} topNav={<TopNav />}>
              {children}
            </AppShell>
          </ToastProvider>
        </ShellChromeProvider>
      </ThemeProvider>
    </SWRConfig>
  );
}
```

- [ ] **Step 3: Trim Sidebar's nav links to the 5 we ship**

Open `apps/web/src/components/layout/sidebar.tsx`. The Railway version may reference all 5 routes already. Confirm the nav array has exactly: `/briefing`, `/team`, `/product`, `/growth`, `/settings`. Remove any extras (e.g. `/calendar`, `/today` if hard-coded as separate items — those should 301 to /briefing in Slice 4 but not appear in nav).

- [ ] **Step 4: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

Fix remaining errors. Common ones: missing `Sidebar.tsx` sub-dependencies (`UserCard`, `NavLink`) — copy them from `src/components/layout/`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/\(app\)/layout.tsx apps/web/src/components/layout/sidebar.tsx
git commit -m "feat(web): port (app) shell with Sidebar, TopNav, SWRConfig, providers"
```

---

### Task 2.5: Build the Settings page

**Files:**
- Create: `apps/web/app/(app)/settings/page.tsx`
- Create: `apps/web/app/(app)/settings/settings-content.tsx`
- Delete: `apps/web/app/(app)/settings/channels/`

- [ ] **Step 1: Read Railway's settings**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/app/(app)/settings/page.tsx
wc -l /Users/yifeng/Documents/Code/shipflare/src/app/(app)/settings/settings-content.tsx
```

- [ ] **Step 2: Port server page**

Create `apps/web/app/(app)/settings/page.tsx`:

```tsx
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/auth";
import { getDrizzle } from "@/lib/drizzle";
import { channels, userPreferences } from "@shipflare/db";
import { SettingsContent } from "./settings-content";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const userId = session.user.id;

  const db = getDrizzle();

  // Whitelist columns — never select `oauthTokenEncrypted` (per CLAUDE.md security TODO)
  const userChannels = await db
    .select({ platform: channels.platform, username: channels.username })
    .from(channels)
    .where(eq(channels.userId, userId))
    .all();

  const prefsRow = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .get();

  return (
    <SettingsContent
      user={{
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }}
      channels={userChannels}
      preferences={{
        timezone: prefsRow?.timezone ?? "UTC",
        theme: prefsRow?.theme ?? "light",
      }}
    />
  );
}
```

- [ ] **Step 3: Port settings-content.tsx**

Copy `src/app/(app)/settings/settings-content.tsx` to `apps/web/app/(app)/settings/settings-content.tsx` verbatim. Then apply edits:

1. Remove the Safety tab (kept hidden in Railway 2026-05-12; confirm the import of `Safety` panel and any conditional rendering of it is removed).
2. Replace Billing tab body with a "Coming soon" stub:

```tsx
function BillingTab() {
  return (
    <div style={{ padding: "var(--sf-space-2xl)", textAlign: "center" }}>
      <div className="sf-h2" style={{ marginBottom: 12 }}>Billing — coming soon</div>
      <div className="sf-body" style={{ color: "var(--sf-fg-3)" }}>
        You're on the free plan during beta. Paid plans will arrive after launch.
      </div>
    </div>
  );
}
```

3. Replace any `useSWR("/api/preferences/timezone")` etc. with a single `useSWR("/api/preferences")` consuming the route we built in Task 2.3.
4. Theme toggle wires through `useTheme()` AND persists via `PATCH /api/preferences { theme }`.
5. X integration shows existing `userChannels` and links to `/api/channels/x/connect` for connect; disconnect TBD or hidden.
6. Reddit is NOT shown in Integrations (no-binding always-on per CLAUDE.md project memory).

- [ ] **Step 4: Delete the old channels page**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/settings/channels
```

- [ ] **Step 5: Typecheck + build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
pnpm build
```

- [ ] **Step 6: Local smoke**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev
```

Sign in. Navigate to `/settings`. Verify:
- Account tab shows email + name
- Integrations tab shows X with "Connect" or "Connected as @…"
- Appearance tab toggles theme (page re-tints immediately, persists across reload)
- Billing tab shows "Coming soon"
- Safety tab is absent

- [ ] **Step 7: Playwright real-browser smoke**

Create `e2e/settings.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("settings shows 4 tabs and persists theme", async ({ page }) => {
  // Assumes the dev's local Chromium is already signed in
  await page.goto("/settings");
  await expect(page.getByRole("tab", { name: /account/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /billing/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /integrations/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /appearance/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: /safety/i })).not.toBeVisible();

  await page.getByRole("tab", { name: /appearance/i }).click();
  await page.getByRole("button", { name: /dark/i }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/app-dark/);
});
```

```bash
pnpm playwright test --grep="settings"
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/\(app\)/settings apps/web/app/\(app\)/settings/settings-content.tsx e2e/settings.spec.ts
git rm -r apps/web/app/\(app\)/settings/channels 2>/dev/null || true
git commit -m "feat(web): port Settings page (Account · Billing stub · Integrations · Appearance)"
```

---

## Slice 3 — Product

### Task 3.1: Add products table

**Files:**
- Create: `packages/db/migrations/003_products.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Write the migration**

Create `packages/db/migrations/003_products.sql`:

```sql
CREATE TABLE IF NOT EXISTS products (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT,
  description TEXT,
  keywords TEXT,        -- JSON array
  value_prop TEXT,
  url TEXT,
  state TEXT NOT NULL DEFAULT 'draft',
  launch_date INTEGER,  -- unix timestamp
  launched_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

- [ ] **Step 2: Add Drizzle schema**

In `packages/db/src/schema.ts`:

```typescript
export const products = sqliteTable("products", {
  userId: text("user_id")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name"),
  description: text("description"),
  keywords: text("keywords", { mode: "json" }).$type<string[]>(),
  valueProp: text("value_prop"),
  url: text("url"),
  state: text("state", { enum: ["draft", "pre-launch", "launched", "growing"] })
    .notNull()
    .default("draft"),
  launchDate: integer("launch_date", { mode: "timestamp" }),
  launchedAt: integer("launched_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
```

Export from `packages/db/src/index.ts`.

- [ ] **Step 3: Apply migration**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm wrangler d1 migrations apply DB --local
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/003_products.sql packages/db/src/schema.ts packages/db/src/index.ts
git commit -m "feat(db): add products table"
```

---

### Task 3.2: Build /api/product route

**Files:**
- Create: `apps/web/app/api/product/route.ts`
- Create: `apps/web/test/api-product.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/api-product.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

describe("/api/product", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM products");
  });

  it("GET returns 401 when unauthenticated", async () => {
    const res = await SELF.fetch("https://test/api/product");
    expect(res.status).toBe(401);
  });

  it("PATCH returns 401 when unauthenticated", async () => {
    const res = await SELF.fetch("https://test/api/product", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm vitest run test/api-product.test.ts
```

- [ ] **Step 3: Write the route**

Create `apps/web/app/api/product/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/auth";
import { getDrizzle } from "@/lib/drizzle";
import { products } from "@shipflare/db";

export const dynamic = "force-dynamic";

type PatchBody = Partial<{
  name: string;
  description: string;
  valueProp: string;
  url: string;
  keywords: string[];
  state: "draft" | "pre-launch" | "launched" | "growing";
  launchDate: number | null;
}>;

export async function GET() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDrizzle();
  const row = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  return NextResponse.json(row ?? {
    userId: session.user.id,
    name: null,
    description: null,
    keywords: [],
    valueProp: null,
    url: null,
    state: "draft",
  });
}

export async function PATCH(req: Request) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as PatchBody;
  const db = getDrizzle();

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  if (body.valueProp !== undefined) set.valueProp = body.valueProp;
  if (body.url !== undefined) set.url = body.url;
  if (body.keywords !== undefined) set.keywords = body.keywords;
  if (body.state !== undefined) set.state = body.state;
  if (body.launchDate !== undefined) {
    set.launchDate = body.launchDate ? new Date(body.launchDate * 1000) : null;
  }

  await db
    .insert(products)
    .values({
      userId: session.user.id,
      ...set,
    })
    .onConflictDoUpdate({ target: products.userId, set });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm vitest run test/api-product.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/product/route.ts apps/web/test/api-product.test.ts
git commit -m "feat(web): /api/product GET + PATCH on D1"
```

---

### Task 3.3: Port Product page UI

**Files:**
- Create: `apps/web/app/(app)/product/page.tsx`
- Create: `apps/web/app/(app)/product/product-content.tsx`
- Create: `apps/web/app/(app)/product/_components/editable-value.tsx`
- Create: `apps/web/src/utils/derivePhase.ts`

- [ ] **Step 1: Copy derivePhase helper**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/src/utils
cp /Users/yifeng/Documents/Code/shipflare/src/utils/derive-phase.ts \
   /Users/yifeng/Documents/Code/shipflare/apps/web/src/utils/derivePhase.ts 2>/dev/null \
   || grep -rl "derivePhase\|derive-phase" /Users/yifeng/Documents/Code/shipflare/src/
```

If the file is named differently, copy it from the location grep reports. Adjust imports.

- [ ] **Step 2: Port the server page**

Create `apps/web/app/(app)/product/page.tsx`:

```tsx
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getAuth } from "@/auth";
import { getDrizzle } from "@/lib/drizzle";
import { products } from "@shipflare/db";
import { ProductContent } from "./product-content";

export const dynamic = "force-dynamic";

export default async function ProductPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const db = getDrizzle();
  const row = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  const initial = row ?? {
    userId: session.user.id,
    name: null,
    description: null,
    keywords: [] as string[],
    valueProp: null,
    url: null,
    state: "draft" as const,
    launchDate: null,
    launchedAt: null,
  };

  return <ProductContent initial={initial} />;
}
```

- [ ] **Step 3: Copy product-content + editable-value verbatim**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/product/_components
cp /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/product/product-content.tsx \
   /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/product/product-content.tsx
cp /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/product/_components/editable-value.tsx \
   /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/product/_components/editable-value.tsx
```

- [ ] **Step 4: Adjust imports**

Open both files and replace:
- `@/lib/db` → drop (not used; props come from server page)
- Postgres-typed `Product` import → `import type { Product } from "@shipflare/db"`
- `useSWR<Product>("/api/product")` should already point at our new route — confirm

- [ ] **Step 5: Typecheck + build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
pnpm build
```

- [ ] **Step 6: Playwright smoke**

Create `e2e/product.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("product page edits persist", async ({ page }) => {
  await page.goto("/product");
  await expect(page.locator("text=Product")).toBeVisible();

  // Click name field, edit, save
  await page.locator("[data-field='name']").click();
  const input = page.locator("[data-field='name'] input, [data-field='name'] textarea");
  await input.fill("ShipFlare Test");
  await input.press("Enter");

  await page.reload();
  await expect(page.locator("[data-field='name']")).toContainText("ShipFlare Test");
});
```

(If the EditableValue component doesn't use `data-field`, inspect the rendered DOM and adjust selectors.)

```bash
pnpm playwright test --grep="product"
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/\(app\)/product apps/web/src/utils/derivePhase.ts e2e/product.spec.ts
git commit -m "feat(web): port Product page with optimistic edit + Drizzle persistence"
```

---

## Slice 4 — Briefing + post-login redirect

### Task 4.1: Build CmoClient with the tools /briefing needs

**Files:**
- Modify: `apps/web/src/lib/cmo-client.ts`

- [ ] **Step 1: Check if cmo-client exists**

```bash
ls /Users/yifeng/Documents/Code/shipflare/apps/web/src/lib/cmo-client.ts 2>/dev/null && echo "exists" || echo "missing — create"
```

- [ ] **Step 2: Create (or extend) cmo-client**

If missing, write `apps/web/src/lib/cmo-client.ts`:

```typescript
"use client";

import { useCallback, useState } from "react";

export interface CmoClient {
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
  stream(
    tool: string,
    args: Record<string, unknown>,
    onChunk: (chunk: string) => void,
  ): Promise<void>;
}

async function fetchMcpToken(): Promise<{ token: string; mcpUrl: string }> {
  const res = await fetch("/api/mcp-token");
  if (!res.ok) throw new Error("mcp-token endpoint failed");
  return res.json();
}

export function useCmoClient(): CmoClient {
  const [_, setTick] = useState(0);

  const call = useCallback(async <T,>(tool: string, args: Record<string, unknown>): Promise<T> => {
    const { token, mcpUrl } = await fetchMcpToken();
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    if (!res.ok) throw new Error(`cmo call ${tool} failed: ${res.status}`);
    return (await res.json()) as T;
  }, []);

  const stream = useCallback(
    async (tool: string, args: Record<string, unknown>, onChunk: (chunk: string) => void) => {
      const { token, mcpUrl } = await fetchMcpToken();
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
        },
        body: JSON.stringify({ tool, args }),
      });
      if (!res.ok || !res.body) throw new Error(`cmo stream ${tool} failed`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        onChunk(dec.decode(value));
      }
    },
    [],
  );

  return { call, stream };
}
```

(If a stream protocol already exists in CF, mirror its shape. This is a baseline — adjust to match the MCP streaming protocol in `apps/core/src/index.ts`.)

- [ ] **Step 3: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/cmo-client.ts
git commit -m "feat(web): CmoClient hook with call() + stream() over MCP JWT"
```

---

### Task 4.2: Port the Briefing page

**Files:**
- Create: `apps/web/app/(app)/briefing/page.tsx`
- Create: `apps/web/app/(app)/briefing/_components/today-tab.tsx`

- [ ] **Step 1: Read Railway's briefing**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/briefing/page.tsx
cat /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/briefing/_components/today-tab.tsx
```

- [ ] **Step 2: Port server page**

Create `apps/web/app/(app)/briefing/page.tsx`:

```tsx
import { TodayTab } from "./_components/today-tab";

export const dynamic = "force-dynamic";

export default function BriefingPage() {
  return (
    <div style={{ paddingTop: 28 }}>
      <TodayTab />
    </div>
  );
}
```

- [ ] **Step 3: Port today-tab.tsx**

Copy `src/app/(app)/today/_components/today-tab.tsx` (or wherever the live TodayBody lives — Railway's today-tab.tsx imports `<TodayBody>` from an internal path; find it):

```bash
grep -rn "export function TodayBody\|export const TodayBody" /Users/yifeng/Documents/Code/shipflare/src/
```

Copy that file and any sub-components into `apps/web/src/components/today/`.

In the ported today-tab.tsx and TodayBody:
1. Replace any Postgres queries with CmoClient calls. Specifically swap `getPlanItemsForToday(userId)` → `cmo.call("listPlanItems", { scheduledOn: "today" })` and `getDraftsPending(userId)` → `cmo.call("listDrafts", { status: "pending" })`.
2. Wrap data fetching in `useEffect` + `useState` (or `useSWR` with the `() => cmo.call(...)` fetcher).
3. Use the `useCmoClient()` hook from Task 4.1.

- [ ] **Step 4: Typecheck + build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
pnpm build
```

- [ ] **Step 5: Local smoke**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev
```

Sign in. After redirect, you should land on `/briefing`. Confirm:
- Today's plan items render (may be empty for a new user; that's fine — empty state should show)
- Pending drafts count visible
- No console errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(app\)/briefing apps/web/src/components/today
git commit -m "feat(web): port Briefing page; reads plan items + drafts via CmoClient"
```

---

### Task 4.3: Wire post-login redirect + 301s + delete CF stubs

**Files:**
- Modify: `apps/web/app/_components/sign-in-button.tsx` (default already `/briefing` from Slice 1)
- Create: `apps/web/next.config.ts` redirect block, or middleware
- Delete: `apps/web/app/(app)/{chat,plan,drafts}/`

- [ ] **Step 1: Confirm SignInButton default**

```bash
grep "callbackURL" /Users/yifeng/Documents/Code/shipflare/apps/web/app/_components/sign-in-button.tsx
```

Expected: `callbackURL = "/briefing"`. If not, fix.

- [ ] **Step 2: Add 301 redirects for /today and /calendar**

Open `apps/web/next.config.ts` and add a `redirects()` block:

```typescript
async redirects() {
  return [
    { source: "/today", destination: "/briefing", permanent: true },
    { source: "/calendar", destination: "/briefing", permanent: true },
  ];
}
```

- [ ] **Step 3: Delete the CF-only pages folded into briefing/team**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/chat
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/plan
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/drafts
```

- [ ] **Step 4: Build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm build
```

Expected: PASS. No 404s on dead imports.

- [ ] **Step 5: Playwright smoke**

Create `e2e/briefing.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("post-login lands on /briefing and renders empty state cleanly", async ({ page }) => {
  // Assumes signed in
  await page.goto("/");
  // If signed in, root may redirect; for now just navigate
  await page.goto("/briefing");
  await expect(page).toHaveURL(/\/briefing/);
  // Briefing renders some heading or "today" text
  await expect(page.locator("body")).toContainText(/today|briefing/i);
});

test("/today redirects to /briefing", async ({ page }) => {
  const res = await page.goto("/today");
  expect(res?.url()).toMatch(/\/briefing/);
});
```

```bash
pnpm playwright test --grep="briefing"
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/next.config.ts e2e/briefing.spec.ts
git rm -rf apps/web/app/\(app\)/chat apps/web/app/\(app\)/plan apps/web/app/\(app\)/drafts 2>/dev/null || true
git commit -m "feat(web): /briefing is post-login landing; /today /calendar 301; delete chat/plan/drafts"
```

---

## Slice 5 — Team (biggest)

### Task 5.1: Port the allocating-plan-items skill

**Files:**
- Create: `packages/skills/skills/allocating-plan-items/SKILL.md`
- Modify: `packages/skills/src/registry.ts`

- [ ] **Step 1: Copy SKILL.md**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/packages/skills/skills/allocating-plan-items
cp /Users/yifeng/Documents/Code/shipflare/src/skills/allocating-plan-items/SKILL.md \
   /Users/yifeng/Documents/Code/shipflare/packages/skills/skills/allocating-plan-items/SKILL.md
```

- [ ] **Step 2: Inline into registry**

Open `packages/skills/src/registry.ts`. Read the file's content; copy it as a template literal value into `SKILL_REGISTRY`:

```typescript
  "allocating-plan-items": `<paste the full SKILL.md content here, with backticks escaped as \\\`>`,
```

To programmatically generate the escape-safe string:

```bash
cd /Users/yifeng/Documents/Code/shipflare/packages/skills/skills/allocating-plan-items
node -e "console.log(JSON.stringify(require('fs').readFileSync('SKILL.md','utf8')))" | head -c 500
```

Use the output (between the surrounding quotes) as the string value, OR use a template literal and manually escape each backtick.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm -r exec tsc --noEmit
```

- [ ] **Step 4: Test the registry includes the skill**

```bash
cd /Users/yifeng/Documents/Code/shipflare/packages/skills
pnpm vitest run
```

If a registry test exists, ensure it passes. If not, add `test/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SKILL_REGISTRY } from "../src/registry";

describe("SKILL_REGISTRY", () => {
  it("includes allocating-plan-items", () => {
    expect(SKILL_REGISTRY).toHaveProperty("allocating-plan-items");
    expect(SKILL_REGISTRY["allocating-plan-items"]).toContain("name: allocating-plan-items");
  });
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/skills/skills/allocating-plan-items packages/skills/src/registry.ts packages/skills/test
git commit -m "feat(skills): port allocating-plan-items skill into CF registry"
```

---

### Task 5.2: Add list_roster MCP tool to CMO (if not present)

**Files:**
- Modify: `apps/core/src/agents/cmo/tools/roster.ts`

- [ ] **Step 1: Check if listRoster exists**

```bash
grep -n "registerTool.*listRoster\|registerTool.*\"list_roster" \
  /Users/yifeng/Documents/Code/shipflare/apps/core/src/agents/cmo/tools/roster.ts
```

If a match is found, skip to Step 4 (commit nothing for this task; mark done).

- [ ] **Step 2: Add the tool registration**

In `apps/core/src/agents/cmo/tools/roster.ts`, inside `registerRosterTools(agent)`, add:

```typescript
  agent.server.registerTool(
    "listRoster",
    {
      description: "List employees for this team. Returns role + status (active/fired) + display name.",
      inputSchema: {},
    },
    async () => {
      const rows = agent.sqlStorage.exec<{
        role: string;
        status: string;
        display_name: string | null;
        hired_at: number | null;
      }>(
        "SELECT role, status, display_name, hired_at FROM roster ORDER BY hired_at ASC NULLS FIRST",
      ).toArray();

      // CMO is implicit — always include even if no roster row
      const employees = [
        { role: "cmo", displayName: "CMO", status: "active" as const, hiredAt: null as number | null },
        ...rows
          .filter((r) => r.role !== "cmo")
          .map((r) => ({
            role: r.role,
            displayName: r.display_name ?? r.role,
            status: r.status as "active" | "fired",
            hiredAt: r.hired_at,
          })),
      ];

      return { content: [{ type: "text" as const, text: JSON.stringify(employees) }] };
    },
  );
```

(Adjust column names to match the actual `roster` SQLite schema in CMO — read `apps/core/src/agents/cmo/CMO.ts` to confirm.)

- [ ] **Step 3: Add a test**

Create or extend `apps/core/test/cmo-roster.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

describe("CMO.listRoster", () => {
  it("returns at least CMO as active", async () => {
    const id = env.CMO.idFromName("test-user");
    const stub = env.CMO.get(id);
    const result = await runInDurableObject(stub, async (instance: any) => {
      // Use the MCP call shape that the worker uses internally — adjust if needed
      return (instance as any).server.listTools();
    });
    expect(result).toBeDefined();
  });
});
```

(If `runInDurableObject` shape doesn't fit, mirror an existing CMO test in `apps/core/test/`.)

- [ ] **Step 4: Run test + typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/core
pnpm vitest run cmo-roster
pnpm tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/tools/roster.ts apps/core/test/cmo-roster.test.ts
git commit -m "feat(core): add listRoster MCP tool on CMO"
```

(Skip commit if Step 1 indicated listRoster already exists.)

---

### Task 5.3: Wholesale-copy team components

**Files:**
- Create: `apps/web/src/components/team/*` (if Railway has shared team components)
- Create: `apps/web/src/hooks/useTeamEvents.ts`

- [ ] **Step 1: Copy useTeamEvents hook**

```bash
cp /Users/yifeng/Documents/Code/shipflare/src/hooks/use-team-events.ts \
   /Users/yifeng/Documents/Code/shipflare/apps/web/src/hooks/useTeamEvents.ts
```

- [ ] **Step 2: Adapt SSE consumer to MCP stream**

Open `apps/web/src/hooks/useTeamEvents.ts`. Find the body that opens `EventSource("/api/team/stream")` or `fetch("/api/team/stream")`. Replace with:

```typescript
import { useCmoClient } from "@/lib/cmo-client";

// Inside the hook:
const cmo = useCmoClient();
// ...
useEffect(() => {
  let cancelled = false;
  (async () => {
    await cmo.stream("chat", { conversationId, message: pendingMessage }, (chunk) => {
      if (cancelled) return;
      dispatch({ type: "stream-chunk", chunk });
    });
  })();
  return () => { cancelled = true; };
}, [conversationId, pendingMessage]);
```

(The exact `dispatch` shape depends on the existing reducer — keep the reducer's contract; only swap the source.)

- [ ] **Step 3: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useTeamEvents.ts
git commit -m "feat(web): port useTeamEvents — SSE → CmoClient.stream adapter"
```

---

### Task 5.4: Port the Team page

**Files:**
- Create: `apps/web/app/(app)/team/page.tsx` (replaces existing stub)
- Create: `apps/web/app/(app)/team/_components/{team-desk,left-rail,conversation,status-banner,sticky-composer}.tsx`

- [ ] **Step 1: Read Railway's team module**

```bash
ls /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/team/_components/
wc -l /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/team/_components/team-desk.tsx
```

- [ ] **Step 2: Copy the team _components verbatim**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/team/_components
cp /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/team/_components/* \
   /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/team/_components/
```

- [ ] **Step 3: Port the page.tsx**

Replace the existing `apps/web/app/(app)/team/page.tsx` (currently a CF stub) with a thin server component:

```tsx
import { headers } from "next/headers";
import { getAuth } from "@/auth";
import { TeamDesk } from "./_components/team-desk";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  return (
    <TeamDesk
      user={{
        id: session.user.id,
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }}
    />
  );
}
```

- [ ] **Step 4: Rewire data sources in team-desk.tsx and sub-components**

In each component under `team/_components/`, replace Postgres / NextAuth / API-route calls with CmoClient calls:

| Old | New |
|---|---|
| `getServerSession()` | prop drilled from `page.tsx` |
| `fetch("/api/team/conversations")` | `cmo.call("listConversations", { ... })` |
| `fetch("/api/team/roster")` | `cmo.call("listRoster", {})` |
| `fetch("/api/team/plan-items")` | `cmo.call("listPlanItems", { ... })` |
| `fetch("/api/team/drafts")` | `cmo.call("listDrafts", { ... })` |
| `useTeamEvents` SSE → MCP stream | (already done in Task 5.3) |
| Click "Approve" | `cmo.call("approveDraft", { draftId })` |
| Click "Reject" | `cmo.call("rejectDraft", { draftId, reason })` |
| Click "Commit strategic path" | `cmo.call("commitStrategicPath", { path })` |
| Send composer message | `cmo.stream("chat", { conversationId, message }, ...)` |

Grep for each old call pattern:

```bash
grep -rn "fetch.*api/team\|getServerSession\|@/lib/db" \
  /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/team/_components/
```

Address each match.

- [ ] **Step 5: Typecheck + build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
pnpm build
```

- [ ] **Step 6: Local smoke**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev
```

Sign in → navigate to `/team`. Verify:
- 3 employees in left rail (CMO + HoG + SMM)
- Type "give me a plan for this week" in composer
- Streaming response appears in middle column
- Plan items appear after agent runs
- Click a pending draft → "Approve" button works

- [ ] **Step 7: Delete memory + mcp-urls pages**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/memory
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/mcp-urls
```

- [ ] **Step 8: Playwright smoke**

Create `e2e/team.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("team page shows roster and accepts composer input", async ({ page }) => {
  await page.goto("/team");
  await expect(page.locator("text=CMO")).toBeVisible();
  await expect(page.locator("text=Social Media")).toBeVisible();

  const composer = page.locator("textarea, [contenteditable]").first();
  await composer.fill("test brief from playwright");
  await composer.press("Enter");
  // Expect SOME response within 30s
  await expect(page.locator("[data-role='assistant'], .agent-message").first()).toBeVisible({ timeout: 30_000 });
});
```

```bash
pnpm playwright test --grep="team"
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/\(app\)/team e2e/team.spec.ts
git rm -rf apps/web/app/\(app\)/memory apps/web/app/\(app\)/mcp-urls 2>/dev/null || true
git commit -m "feat(web): port Team page with CmoClient wiring; delete memory + mcp-urls"
```

---

## Slice 6 — Growth

### Task 6.1: Add growth_snapshots table

**Files:**
- Create: `packages/db/migrations/004_growth_snapshots.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Write migration**

Create `packages/db/migrations/004_growth_snapshots.sql`:

```sql
CREATE TABLE IF NOT EXISTS growth_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  metrics TEXT NOT NULL,    -- JSON: { impressions, replies, followers, posts, ... }
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_growth_user_platform_captured
  ON growth_snapshots(user_id, platform, captured_at DESC);
```

- [ ] **Step 2: Add Drizzle schema**

In `packages/db/src/schema.ts`:

```typescript
export const growthSnapshots = sqliteTable(
  "growth_snapshots",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: ["x", "reddit"] }).notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp" }).notNull(),
    metrics: text("metrics", { mode: "json" }).$type<Record<string, number>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userPlatformCaptured: index("idx_growth_user_platform_captured").on(
      t.userId,
      t.platform,
      t.capturedAt,
    ),
  }),
);

export type GrowthSnapshot = typeof growthSnapshots.$inferSelect;
export type NewGrowthSnapshot = typeof growthSnapshots.$inferInsert;
```

Export from `packages/db/src/index.ts`. Add the `index` import if not already at the top of schema.ts.

- [ ] **Step 3: Apply migration**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm wrangler d1 migrations apply DB --local
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/004_growth_snapshots.sql packages/db/src/schema.ts packages/db/src/index.ts
git commit -m "feat(db): add growth_snapshots table"
```

---

### Task 6.2: Cron writer for growth snapshots

**Files:**
- Modify: `apps/core/src/index.ts` (cron handler)
- Modify: `apps/core/wrangler.jsonc` (confirm cron `*/6 * * * *`)

- [ ] **Step 1: Find existing cron handler**

```bash
grep -n "scheduled\|cron" /Users/yifeng/Documents/Code/shipflare/apps/core/src/index.ts
```

- [ ] **Step 2: Adjust cron cadence to every 6 hours**

In `apps/core/wrangler.jsonc`, ensure:

```jsonc
  "triggers": { "crons": ["0 */6 * * *"] },
```

(If the project uses `*/6 * * * *` already, leave it.)

- [ ] **Step 3: Extend the cron handler**

In `apps/core/src/index.ts`, locate the `scheduled` export (or equivalent cron trigger handler) and add a growth snapshot fan-out step:

```typescript
async function snapshotGrowth(env: Env): Promise<void> {
  const db = drizzle(env.DB, { schema });
  // Fan out across users who have at least one channel
  const users = await db
    .select({ userId: schema.channels.userId, platform: schema.channels.platform })
    .from(schema.channels)
    .groupBy(schema.channels.userId, schema.channels.platform)
    .all();

  await Promise.all(
    users.map(async ({ userId, platform }) => {
      try {
        const metrics = await fetchPlatformMetrics(env, userId, platform);
        await db.insert(schema.growthSnapshots).values({
          id: crypto.randomUUID(),
          userId,
          platform: platform as "x" | "reddit",
          capturedAt: new Date(),
          metrics,
          createdAt: new Date(),
        });
      } catch (err) {
        console.warn(`growth snapshot failed for ${userId}/${platform}:`, err);
      }
    }),
  );
}

async function fetchPlatformMetrics(env: Env, userId: string, platform: string): Promise<Record<string, number>> {
  if (platform === "x") {
    // Call XMcpAgent's x_metrics via service binding / DO
    const stub = env.X_MCP.get(env.X_MCP.idFromName(userId));
    const res = await stub.fetch("https://internal/agents/x/" + userId + "/internal/metrics", {
      method: "POST",
      headers: { "x-shipflare-internal": "1" },
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, number>;
  }
  if (platform === "reddit") {
    const stub = env.REDDIT_MCP.get(env.REDDIT_MCP.idFromName(userId));
    const res = await stub.fetch("https://internal/agents/reddit/" + userId + "/internal/metrics", {
      method: "POST",
      headers: { "x-shipflare-internal": "1" },
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, number>;
  }
  return {};
}
```

In the `scheduled` handler, call `await snapshotGrowth(env);` alongside any existing fan-out.

- [ ] **Step 4: Confirm X_MCP and REDDIT_MCP have an internal metrics endpoint**

```bash
grep -rn "internal/metrics\|/internal/metrics" /Users/yifeng/Documents/Code/shipflare/apps/core/src/agents/platforms/
```

If absent, add a minimal handler to each platform's `internal/<path>` router:

```typescript
// In XMcpAgent.ts and RedditMcpAgent.ts, inside the DO's internal router:
if (path === "/internal/metrics") {
  // Returns whatever metrics the agent already collects in SQLite
  const row = this.sqlStorage.exec<{ metrics: string }>(
    "SELECT metrics FROM call_cache WHERE key='metrics' ORDER BY captured_at DESC LIMIT 1"
  ).toArray()[0];
  return new Response(row?.metrics ?? "{}", { headers: { "content-type": "application/json" } });
}
```

(If the platform agent doesn't currently collect metrics, the snapshot rows will be empty objects. That's acceptable for slice 6 — the page renders zeros, and a future slice can wire real metric collection.)

- [ ] **Step 5: Typecheck**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm -r exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/index.ts apps/core/wrangler.jsonc apps/core/src/agents/platforms
git commit -m "feat(core): growth_snapshots cron fan-out every 6h; X/Reddit internal/metrics endpoints"
```

---

### Task 6.3: Build /api/growth/overview

**Files:**
- Create: `apps/web/app/api/growth/overview/route.ts`
- Create: `apps/web/test/api-growth.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

describe("/api/growth/overview", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM growth_snapshots");
  });

  it("GET returns 401 when unauthenticated", async () => {
    const res = await SELF.fetch("https://test/api/growth/overview");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm vitest run test/api-growth.test.ts
```

- [ ] **Step 3: Write the route**

Create `apps/web/app/api/growth/overview/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { and, eq, desc } from "drizzle-orm";
import { getAuth } from "@/auth";
import { getDrizzle } from "@/lib/drizzle";
import { channels, growthSnapshots } from "@shipflare/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = getDrizzle();
  const userId = session.user.id;

  const userChannels = await db
    .select({ platform: channels.platform, username: channels.username })
    .from(channels)
    .where(eq(channels.userId, userId))
    .all();

  const platforms: Array<"x" | "reddit"> = ["x", "reddit"];
  const cards = await Promise.all(
    platforms.map(async (platform) => {
      const snap = await db
        .select()
        .from(growthSnapshots)
        .where(and(eq(growthSnapshots.userId, userId), eq(growthSnapshots.platform, platform)))
        .orderBy(desc(growthSnapshots.capturedAt))
        .limit(1)
        .get();
      const channel = userChannels.find((c) => c.platform === platform);
      return {
        platform,
        live: Boolean(channel),
        username: channel?.username ?? null,
        metrics: snap?.metrics ?? {},
        capturedAt: snap?.capturedAt ?? null,
      };
    }),
  );

  return NextResponse.json({
    overallScore: cards.filter((c) => c.live).length * 50, // crude placeholder
    modules: [
      {
        id: "social",
        displayName: "Social",
        managerTitle: "Social Media Manager",
        live: cards.some((c) => c.live),
        score: cards.filter((c) => c.live).length * 50,
        channels: cards,
      },
    ],
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm vitest run test/api-growth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/growth/overview/route.ts apps/web/test/api-growth.test.ts
git commit -m "feat(web): /api/growth/overview reads latest snapshots + channel status"
```

---

### Task 6.4: Port Growth page

**Files:**
- Create: `apps/web/app/(app)/growth/page.tsx`
- Create: `apps/web/app/(app)/growth/growth-content.tsx`
- Create: `apps/web/app/(app)/growth/_components/{overall-hero,social-panel,channel-card}.tsx`

- [ ] **Step 1: Copy the growth tree**

```bash
mkdir -p /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/growth/_components
cp /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/growth/page.tsx \
   /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/growth/page.tsx
cp /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/growth/growth-content.tsx \
   /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/growth/growth-content.tsx
cp /Users/yifeng/Documents/Code/shipflare/src/app/\(app\)/growth/_components/* \
   /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/growth/_components/
```

- [ ] **Step 2: Adjust imports**

Run:

```bash
grep -rn "from ['\"]@/lib/\|from ['\"]next-auth" \
  /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/growth/
```

Replace each match with CF-compatible equivalents. The page should call `useSWR("/api/growth/overview")` already.

- [ ] **Step 3: Typecheck + build**

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/web
pnpm tsc --noEmit
pnpm build
```

- [ ] **Step 4: Delete notifications**

```bash
rm -rf /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/notifications
```

- [ ] **Step 5: Local smoke**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev
```

`/growth` should render with:
- Overall dial showing a score (50 or 0 depending on channel state)
- One module ("Social") expanded
- X + Reddit cards (X "Live" if connected, Reddit "Live" no-binding)
- Metrics may be empty/zero until first cron fires

To trigger cron manually:

```bash
cd /Users/yifeng/Documents/Code/shipflare/apps/core
pnpm wrangler dev --test-scheduled
# In another terminal:
curl "http://localhost:8787/__scheduled?cron=0+0/6+*+*+*"
```

Reload `/growth` — metrics should now show last-captured values.

- [ ] **Step 6: Playwright smoke**

Create `e2e/growth.spec.ts`:

```typescript
import { test, expect } from "@playwright/test";

test("growth page renders overall + social panel + 2 channels", async ({ page }) => {
  await page.goto("/growth");
  await expect(page.locator("text=Growth")).toBeVisible();
  await expect(page.locator("text=Social")).toBeVisible();
  await expect(page.locator("text=X").or(page.locator("text=Twitter"))).toBeVisible();
  await expect(page.locator("text=Reddit")).toBeVisible();
});
```

```bash
pnpm playwright test --grep="growth"
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/\(app\)/growth e2e/growth.spec.ts
git rm -rf apps/web/app/\(app\)/notifications 2>/dev/null || true
git commit -m "feat(web): port Growth page; delete notifications; complete 6-slice migration"
```

---

## Final verification

### Task F.1: Slice-by-slice sanity sweep

- [ ] **Step 1: Confirm all 5 logged-in pages + landing render**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm dev
```

Walk through:
- `/` — landing with hero + 2 CTAs
- `/briefing` — today's items + drafts
- `/team` — roster + composer + streaming chat
- `/product` — editable fields
- `/growth` — overall + social cards
- `/settings` — 4 tabs (Billing stubbed)

- [ ] **Step 2: Confirm dead routes removed**

```bash
for p in chat plan drafts memory mcp-urls notifications; do
  test ! -d /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/$p && echo "✓ $p removed" || echo "✗ $p still present"
done
```

- [ ] **Step 3: All tests pass**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm -r test
pnpm playwright test
```

- [ ] **Step 4: Production build green**

```bash
pnpm -r build
```

- [ ] **Step 5: Final commit (or push for review)**

```bash
git push origin HEAD
```

Open a PR titled "Railway → Cloudflare frontend migration (6 slices)" referencing the spec at `docs/superpowers/specs/2026-05-14-railway-to-cf-frontend-migration-design.md`.
