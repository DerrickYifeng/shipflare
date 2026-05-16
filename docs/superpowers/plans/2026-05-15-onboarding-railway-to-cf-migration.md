# Railway → Cloudflare Onboarding Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal `apps/web/app/onboarding/` placeholder with a 1:1 port of the Railway 7-stage onboarding flow (UI + API + backend deps), wired to Cloudflare infra (D1, Workers, CMO Durable Object).

**Architecture:**
- **UI**: Copy `/src/components/onboarding/` → `apps/web/app/onboarding/_components/`. Keep the OnboardingFlow state machine + ProgressRail/MobileHeader chrome + 7 stage components.
- **Draft persistence**: Railway used Redis. CF uses a new D1 table `onboarding_drafts` (single row per user, JSON payload column). Lives in `packages/db/src/schema.ts`.
- **Schema**: Extend the `products` D1 table with `category`, `targetAudience`, `launchChannel`, `usersBucket`, `onboardingCompletedAt`; change `state` enum to Railway's `mvp/launching/launched`.
- **Strategic path canonical store**: CMO Durable Object's SQLite `strategic_path` table (already exists). The new `/api/onboarding/plan` route generates a `StrategicPath` via a single Anthropic structured-output call, then `/api/onboarding/commit` calls CMO RPC `commitStrategicPath` to persist.
- **Scraper + SEO audit**: Port from `src/services/web-scraper.ts` + `src/tools/seo-audit.ts` to `apps/web/src/lib/`. Use Workers-native `fetch` + `cheerio` + `turndown`.
- **GitHub repos**: Better Auth's `account` table already holds the GitHub `accessToken`. New `apps/web/src/lib/github.ts` reads it directly.
- **Stage 4 Connect**: Reuse existing `/api/channels/{x,reddit}/connect` routes; no new code.

**Tech Stack:** Next.js 15 App Router (OpenNext on Workers), Drizzle ORM + D1, Better Auth, Anthropic SDK (`@anthropic-ai/sdk`), `cheerio`, `turndown`, Zod, React 19, Cloudflare Durable Objects (CMO).

---

## File Structure

### New files
- `packages/db/migrations/0007_onboarding_schema.sql` — schema migration
- `apps/web/src/lib/launch-phase.ts` — phase derivation
- `apps/web/src/lib/launch-date-rules.ts` — date validation
- `apps/web/src/lib/onboarding-draft.ts` — D1-backed draft CRUD
- `apps/web/src/lib/scraper.ts` — Turndown-based scraper
- `apps/web/src/lib/seo-audit.ts` — cheerio-based SEO audit
- `apps/web/src/lib/anthropic.ts` — Anthropic SDK init helper
- `apps/web/src/lib/strategic-path-schema.ts` — Zod schemas for StrategicPath
- `apps/web/src/lib/github.ts` — GitHub OAuth token lookup + repo APIs
- `apps/web/src/lib/types/onboarding.ts` — `ExtractedProfile` interface
- `apps/web/app/api/onboarding/draft/route.ts` — GET/PUT/DELETE
- `apps/web/app/api/onboarding/extract/route.ts` — URL extract
- `apps/web/app/api/onboarding/extract-repo/route.ts` — GitHub repo extract (README-based, non-SSE)
- `apps/web/app/api/onboarding/github-repos/route.ts` — repo list
- `apps/web/app/api/onboarding/plan/route.ts` — SSE strategic-path generation
- `apps/web/app/api/onboarding/commit/route.ts` — finalize + redirect target
- `apps/web/app/onboarding/_components/*` — 22 ported component files (mirrors `src/components/onboarding/`)

### Modified files
- `packages/db/src/schema.ts` — products + onboarding_drafts
- `apps/web/wrangler.jsonc` — declare CORE RPC binding name `CMO` already exists; add ANTHROPIC_API_KEY as a secret note
- `apps/web/package.json` — `cheerio`, `turndown`, `@anthropic-ai/sdk` (verify present)
- `apps/web/app/onboarding/page.tsx` — render OnboardingFlow (drop OnboardingForm)
- `apps/web/app/onboarding/layout.tsx` — full-bleed shell
- `apps/web/src/auth.ts` — GitHub scope `repo` (or `public_repo`) so `github-repos` works

### Deleted files
- `apps/web/app/onboarding/_components/onboarding-form.tsx` — replaced by full flow

---

## Pre-flight Checks

- [ ] **P0: Confirm CMO RPC binding name in apps/web**

Run: `grep -n "CMO\b" apps/web/src/env.d.ts apps/web/wrangler.jsonc 2>/dev/null`

Expected: A `CMO` binding exists in `apps/web/wrangler.jsonc` (or via `CORE` service binding that proxies to CMO).
If only `CORE` is bound (service binding) without DO namespace, the commit route will call CMO via `env.CORE.fetch("https://internal/agents/cmo/<userId>/...")`. Note the actual mechanism here and use it in B6 below.

- [ ] **P1: Confirm Anthropic SDK is available**

Run: `cat apps/web/package.json | grep anthropic`

If missing: add to `apps/web/package.json` dependencies: `"@anthropic-ai/sdk": "^0.30.0"`, then `pnpm install`.

- [ ] **P2: Confirm `ANTHROPIC_API_KEY` will be set as a Worker secret**

Document in plan exit: `cd apps/web && pnpm exec wrangler secret put ANTHROPIC_API_KEY` is required before deploy. The route should throw clear `503 anthropic_not_configured` if missing.

---

## Phase A — Foundations: Schema + Library

### Task A1: Extend `products` schema and add `onboarding_drafts` table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0007_onboarding_schema.sql`

- [ ] **Step 1: Edit `packages/db/src/schema.ts` products table**

Find the `products = sqliteTable("products", { ... })` block. Replace the `state` column and add new columns. The block becomes:

```typescript
export const products = sqliteTable("products", {
  userId: text("userId")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name"),
  description: text("description"),
  keywords: text("keywords", { mode: "json" }).$type<string[]>(),
  valueProp: text("valueProp"),
  url: text("url"),
  category: text("category", {
    enum: [
      "dev_tool",
      "saas",
      "consumer",
      "creator_tool",
      "agency",
      "ai_app",
      "other",
    ],
  }),
  targetAudience: text("targetAudience"),
  state: text("state", {
    enum: ["mvp", "launching", "launched"],
  })
    .notNull()
    .default("mvp"),
  launchDate: integer("launchDate", { mode: "timestamp_ms" }),
  launchedAt: integer("launchedAt", { mode: "timestamp_ms" }),
  launchChannel: text("launchChannel", {
    enum: ["producthunt", "showhn", "both", "other"],
  }),
  usersBucket: text("usersBucket", {
    enum: ["<100", "100-1k", "1k-10k", "10k+"],
  }),
  onboardingCompletedAt: integer("onboardingCompletedAt", {
    mode: "timestamp_ms",
  }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

- [ ] **Step 2: Add `onboarding_drafts` table at the end of `schema.ts`**

Append after the existing `allowedEmails` block:

```typescript
// ─── ShipFlare onboarding draft (1) ────────────────────────────────────────
//
// One row per user. Holds the in-progress onboarding state across page
// refreshes. Cleared by /api/onboarding/commit on success. Schema is
// intentionally a free-form JSON blob so frontend can add fields between
// stages without a migration.

export const onboardingDrafts = sqliteTable("onboarding_drafts", {
  userId: text("userId")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type OnboardingDraftRow = typeof onboardingDrafts.$inferSelect;
```

- [ ] **Step 3: Create the migration SQL**

Write `packages/db/migrations/0007_onboarding_schema.sql`:

```sql
-- Migration 0007: onboarding flow schema
-- - Extend `products` with category/targetAudience/launchChannel/usersBucket/onboardingCompletedAt
-- - Change `state` enum from (draft/pre-launch/launched/growing) → (mvp/launching/launched)
-- - Add `onboarding_drafts` table

-- 1) Add new columns to products. SQLite can't ALTER existing enums, but the
--    string column accepts any text — Drizzle's enum is enforced in
--    application-level types only. Existing rows with stale states will be
--    coerced by the application layer on first read; new writes go through
--    Zod validation.
ALTER TABLE products ADD COLUMN category TEXT;
ALTER TABLE products ADD COLUMN targetAudience TEXT;
ALTER TABLE products ADD COLUMN launchChannel TEXT;
ALTER TABLE products ADD COLUMN usersBucket TEXT;
ALTER TABLE products ADD COLUMN onboardingCompletedAt INTEGER;

-- 2) Map legacy state values to the new enum.
UPDATE products SET state = 'mvp' WHERE state = 'draft';
UPDATE products SET state = 'launching' WHERE state = 'pre-launch';
UPDATE products SET state = 'launched' WHERE state = 'growing';

-- 3) Onboarding drafts table
CREATE TABLE IF NOT EXISTS onboarding_drafts (
  userId TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);
```

- [ ] **Step 4: Apply the migration locally + remote**

Run (locally): `cd apps/web && pnpm exec wrangler d1 migrations apply shipflare-prod --local`

Expected output: `✅ Successfully applied 1 migration(s)`

Then (remote, after review): `pnpm exec wrangler d1 migrations apply shipflare-prod --remote`

- [ ] **Step 5: Update existing code that references the old state enum**

Two files in `apps/web/` use the old `draft|pre-launch|launched|growing` enum and must be migrated atomically with the schema change. The migration in Step 3 coerced existing rows; this step fixes the TypeScript code that talks about those states.

**File 1: `apps/web/app/api/product/route.ts`**

Read the file. Replace the `ProductState` type definition (around line 22-29) with:

```typescript
type ProductState = "mvp" | "launching" | "launched";
const PRODUCT_STATES: readonly ProductState[] = [
  "mvp",
  "launching",
  "launched",
] as const;
```

Then find the GET handler block that returns defaults when no row exists (around line 54) and change `state: "draft" as ProductState` to `state: "mvp" as ProductState`.

**File 2: `apps/web/app/(app)/product/product-content.tsx`**

Read the file. This file has a local `derivePhase` and a `STATE_LABEL` map adapted to the OLD enum. Convert them to the new enum. Specifically:

1. Replace the local `derivePhase` (around line 56-90) with an import from the new `@/lib/launch-phase`:

```typescript
import { derivePhase } from "@/lib/launch-phase";
```

   …and delete the inline copy.

2. Update the `state` type annotation: any place declaring `state: "draft" | "pre-launch" | "launched" | "growing"` becomes `state: "mvp" | "launching" | "launched"`.

3. Update the `STATE_LABEL` object: keys become `mvp`, `launching`, `launched`. Use these labels:
   - `mvp` → "Building"
   - `launching` → "Launching"
   - `launched` → "Launched"

4. Update the `getLabel` function (around line 408-409):

```typescript
if (state === "mvp") return STATE_LABEL.mvp;
if (state === "launching") {
  // existing pre-launch logic (uses launchDate)
  ...
}
```

5. Update the initial `data.state ?? 'draft'` fallback (around line 132) to `data.state ?? 'mvp'`.

6. If there are radio/select options in the JSX for picking state, update their values and labels to match the new enum.

After edits, run: `cd apps/web && pnpm tsc --noEmit --pretty false`

Iterate until 0 errors. The compiler will surface any spots you missed.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations/0007_onboarding_schema.sql apps/web/app/api/product/route.ts apps/web/app/\(app\)/product/product-content.tsx
git commit -m "feat(db): onboarding schema — products fields + onboarding_drafts + enum migration"
```

---

### Task A2: Port `launch-phase.ts` (verbatim)

**Files:**
- Create: `apps/web/src/lib/launch-phase.ts`

- [ ] **Step 1: Copy verbatim from `src/lib/launch-phase.ts`**

Run: `cp /Users/yifeng/Documents/Code/shipflare/src/lib/launch-phase.ts /Users/yifeng/Documents/Code/shipflare/apps/web/src/lib/launch-phase.ts`

Then verify no internal imports broke:

```bash
grep "^import" apps/web/src/lib/launch-phase.ts
```

Expected: only relative `type ProductState`-style imports OR none. If any `@/lib/...` imports exist, change to relative.

- [ ] **Step 2: Add a unit test**

Create `apps/web/src/lib/__tests__/launch-phase.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { derivePhase } from "../launch-phase";

describe("derivePhase", () => {
  const now = new Date("2026-05-15T00:00:00Z");

  it("returns steady for launched without launchedAt", () => {
    expect(derivePhase({ state: "launched", launchDate: null, launchedAt: null, now })).toBe("steady");
  });

  it("returns compound within 30 days of launch", () => {
    const launchedAt = new Date("2026-04-30T00:00:00Z");
    expect(derivePhase({ state: "launched", launchDate: null, launchedAt, now })).toBe("compound");
  });

  it("returns foundation for mvp without launchDate", () => {
    expect(derivePhase({ state: "mvp", launchDate: null, launchedAt: null, now })).toBe("foundation");
  });

  it("returns launch on launch day", () => {
    const launchDate = new Date("2026-05-15T00:00:00Z");
    expect(derivePhase({ state: "launching", launchDate, launchedAt: null, now })).toBe("launch");
  });

  it("returns momentum within 7 days of launch", () => {
    const launchDate = new Date("2026-05-20T00:00:00Z");
    expect(derivePhase({ state: "launching", launchDate, launchedAt: null, now })).toBe("momentum");
  });

  it("returns audience within 28 days of launch", () => {
    const launchDate = new Date("2026-06-05T00:00:00Z");
    expect(derivePhase({ state: "launching", launchDate, launchedAt: null, now })).toBe("audience");
  });
});
```

- [ ] **Step 3: Run tests, verify PASS**

Run: `cd apps/web && pnpm vitest run src/lib/__tests__/launch-phase.test.ts`

Expected: 6 passed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/launch-phase.ts apps/web/src/lib/__tests__/launch-phase.test.ts
git commit -m "feat(web): port launch-phase lib + tests"
```

---

### Task A3: Port `launch-date-rules.ts` (verbatim)

**Files:**
- Create: `apps/web/src/lib/launch-date-rules.ts`

- [ ] **Step 1: Copy verbatim, fix imports**

Run: `cp /Users/yifeng/Documents/Code/shipflare/src/lib/launch-date-rules.ts /Users/yifeng/Documents/Code/shipflare/apps/web/src/lib/launch-date-rules.ts`

Then fix the import header — replace `from './launch-phase'` with `from "./launch-phase"` (same line, just confirm relative import is intact).

- [ ] **Step 2: Add a unit test**

Create `apps/web/src/lib/__tests__/launch-date-rules.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateLaunchDates } from "../launch-date-rules";

describe("validateLaunchDates", () => {
  const now = new Date("2026-05-15T00:00:00Z").getTime();

  it("launching requires launchDate", () => {
    const errs = validateLaunchDates({ state: "launching", launchDate: null, launchedAt: null }, now);
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("launchDate");
  });

  it("launching accepts a date 30 days from now", () => {
    const d = new Date(now + 30 * 86_400_000).toISOString();
    const errs = validateLaunchDates({ state: "launching", launchDate: d, launchedAt: null }, now);
    expect(errs).toHaveLength(0);
  });

  it("launching rejects a date 100 days from now", () => {
    const d = new Date(now + 100 * 86_400_000).toISOString();
    const errs = validateLaunchDates({ state: "launching", launchDate: d, launchedAt: null }, now);
    expect(errs).toHaveLength(1);
  });

  it("launched requires launchedAt", () => {
    const errs = validateLaunchDates({ state: "launched", launchDate: null, launchedAt: null }, now);
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe("launchedAt");
  });
});
```

- [ ] **Step 3: Run tests, verify PASS**

Run: `cd apps/web && pnpm vitest run src/lib/__tests__/launch-date-rules.test.ts`

Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/launch-date-rules.ts apps/web/src/lib/__tests__/launch-date-rules.test.ts
git commit -m "feat(web): port launch-date-rules lib + tests"
```

---

### Task A4: Add `onboarding-draft.ts` (D1-backed)

**Files:**
- Create: `apps/web/src/lib/onboarding-draft.ts`

- [ ] **Step 1: Write the module**

Create `apps/web/src/lib/onboarding-draft.ts`:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { onboardingDrafts, eq } from "@shipflare/db";
import { drizzle } from "drizzle-orm/d1";

export interface OnboardingDraft {
  source?: "url" | "github" | "manual";
  url?: string | null;
  githubRepo?: string | null;
  name?: string;
  description?: string;
  valueProp?: string | null;
  keywords?: string[];
  targetAudience?: string | null;
  category?:
    | "dev_tool"
    | "saas"
    | "consumer"
    | "creator_tool"
    | "agency"
    | "ai_app"
    | "other";
  reviewed?: boolean;
  channels?: Array<"x" | "reddit" | "email">;
  state?: "mvp" | "launching" | "launched";
  launchDate?: string | null;
  launchedAt?: string | null;
  launchChannel?: "producthunt" | "showhn" | "both" | "other" | null;
  usersBucket?: "<100" | "100-1k" | "1k-10k" | "10k+" | null;
  previewPath?: unknown;
  updatedAt?: string;
}

function getDb(d1: D1Database) {
  return drizzle(d1);
}

export async function getDraft(
  d1: D1Database,
  userId: string,
): Promise<OnboardingDraft | null> {
  const db = getDb(d1);
  const row = await db
    .select()
    .from(onboardingDrafts)
    .where(eq(onboardingDrafts.userId, userId))
    .get();
  if (!row) return null;
  return row.payload as OnboardingDraft;
}

export async function putDraft(
  d1: D1Database,
  userId: string,
  patch: Partial<OnboardingDraft>,
): Promise<OnboardingDraft> {
  const db = getDb(d1);
  const existing = await getDraft(d1, userId);
  const next: OnboardingDraft = {
    ...(existing ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(onboardingDrafts)
    .values({
      userId,
      payload: next as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: onboardingDrafts.userId,
      set: {
        payload: next as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });
  return next;
}

export async function deleteDraft(
  d1: D1Database,
  userId: string,
): Promise<void> {
  const db = getDb(d1);
  await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userId));
}
```

- [ ] **Step 2: Verify `eq` and `onboardingDrafts` are exported from `@shipflare/db`**

Run: `grep -n "export.*onboardingDrafts\|export.*eq" packages/db/src/index.ts packages/db/src/schema.ts 2>/dev/null`

If `eq` isn't re-exported, add to `packages/db/src/index.ts`:

```typescript
export { eq, and, or, sql, desc, asc } from "drizzle-orm";
```

And re-export the new table:

```typescript
export { onboardingDrafts, type OnboardingDraftRow } from "./schema";
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/onboarding-draft.ts packages/db/src/index.ts
git commit -m "feat(web): D1-backed onboarding draft store"
```

---

### Task A5: Port `scraper.ts` (Turndown + cheerio)

**Files:**
- Create: `apps/web/src/lib/scraper.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Add dependencies**

Run: `cd apps/web && pnpm add cheerio turndown && pnpm add -D @types/turndown`

Verify `package.json` shows `cheerio`, `turndown`, `@types/turndown`.

- [ ] **Step 2: Copy `web-scraper.ts` → `scraper.ts`, rewire imports**

Read `src/services/web-scraper.ts` in full and write `apps/web/src/lib/scraper.ts`:
- Remove import of `@/core/api-client` (use the new `anthropic.ts` helper from A7 instead — defer the `analyzeWebsite` portion until A7 lands; for now, port ONLY `scrapeWebsite()` + `validateURL()` + `isPermittedRedirect()` + `fetchWithSafeRedirects()` + `emptyResult()`).
- Remove import of `@/lib/logger` — replace `log.error(...)` with `console.error(...)` and `log.warn` with `console.warn` (Workers logs ship to wrangler tail).
- Remove import of `@/types/code-scanner` — the `analyzeWebsite` function and `ProductAnalysis` type land in A7.

The file should export only `scrapeWebsite(url: string): Promise<WebScrapeResult>` plus the `WebScrapeResult` type.

- [ ] **Step 3: Add a smoke test**

Create `apps/web/src/lib/__tests__/scraper.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scrapeWebsite } from "../scraper";

describe("scrapeWebsite", () => {
  it("rejects single-label hostnames", async () => {
    const result = await scrapeWebsite("http://localhost/");
    expect(result.status).toBe("error");
    expect(result.error).toBe("Invalid URL");
  });

  it("rejects URLs with embedded credentials", async () => {
    const result = await scrapeWebsite("https://user:pass@example.com/");
    expect(result.status).toBe("error");
  });

  it("rejects pathologically long URLs", async () => {
    const result = await scrapeWebsite("https://example.com/" + "a".repeat(3000));
    expect(result.status).toBe("error");
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd apps/web && pnpm vitest run src/lib/__tests__/scraper.test.ts`

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/scraper.ts apps/web/src/lib/__tests__/scraper.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): port web-scraper (scrape only, analyze lands in A7)"
```

---

### Task A6: Port `seo-audit.ts`

**Files:**
- Create: `apps/web/src/lib/seo-audit.ts`

- [ ] **Step 1: Copy verbatim**

Run: `cp /Users/yifeng/Documents/Code/shipflare/src/tools/seo-audit.ts /Users/yifeng/Documents/Code/shipflare/apps/web/src/lib/seo-audit.ts`

Verify no `@/` imports (cheerio only). The file is self-contained.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/seo-audit.ts
git commit -m "feat(web): port seo-audit lib"
```

---

### Task A7: Add `anthropic.ts` helper + finish `analyzeWebsite`

**Files:**
- Create: `apps/web/src/lib/anthropic.ts`
- Modify: `apps/web/src/lib/scraper.ts`

- [ ] **Step 1: Verify Anthropic SDK is installed**

Run: `grep '"@anthropic-ai/sdk"' apps/web/package.json`

If missing: `cd apps/web && pnpm add @anthropic-ai/sdk`

- [ ] **Step 2: Write `apps/web/src/lib/anthropic.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";

export function getAnthropic(apiKey: string | undefined): Anthropic {
  if (!apiKey) {
    throw new Error("anthropic_not_configured");
  }
  return new Anthropic({ apiKey });
}

export interface ProductAnalysis {
  productName: string;
  oneLiner: string;
  targetAudience: string;
  keywords: string[];
  valueProp: string;
}
```

- [ ] **Step 3: Append `analyzeWebsite` to `apps/web/src/lib/scraper.ts`**

Append (after `scrapeWebsite`):

```typescript
import { getAnthropic, type ProductAnalysis } from "./anthropic";

const ANALYZE_PROMPT = `You analyze websites to understand what product or service they offer.
Given the page content below, extract:

1. productName — the actual product/brand name (not the domain)
2. oneLiner — one sentence describing what it does, in plain language
3. targetAudience — who this product is for (be specific: "indie developers", "small business owners", etc.)
4. keywords — 5-8 topic keywords a potential user would search for (lowercase, no brand names)
5. valueProp — the core value proposition in one sentence

Respond with ONLY a JSON object matching this shape:
{"productName":"...","oneLiner":"...","targetAudience":"...","keywords":["..."],"valueProp":"..."}`;

export async function analyzeWebsite(
  scrape: WebScrapeResult,
  anthropicApiKey: string,
): Promise<ProductAnalysis> {
  const content = [
    `URL: ${scrape.url}`,
    scrape.title ? `Title: ${scrape.title}` : "",
    scrape.description ? `Meta Description: ${scrape.description}` : "",
    scrape.pageMarkdown ? `\nPage Content:\n${scrape.pageMarkdown}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const client = getAnthropic(anthropicApiKey);
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: ANALYZE_PROMPT,
      messages: [{ role: "user", content }],
    });
    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
    return {
      productName: parsed.productName || fallbackName(scrape.title, scrape.url),
      oneLiner: parsed.oneLiner || scrape.description,
      targetAudience: parsed.targetAudience || "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      valueProp: parsed.valueProp || "",
    };
  } catch (error) {
    console.error(`analyzeWebsite failed:`, error);
    return {
      productName: fallbackName(scrape.title, scrape.url),
      oneLiner: scrape.description,
      targetAudience: "",
      keywords: [],
      valueProp: "",
    };
  }
}

function fallbackName(title: string, url: string): string {
  const separators = /\s*[–\-|:·]\s*/;
  const parts = title.split(separators).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].split(/\s+/).length <= 4) {
    return parts[0];
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname.split(".")[0];
  } catch {
    return title || "Unknown";
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/anthropic.ts apps/web/src/lib/scraper.ts
git commit -m "feat(web): anthropic helper + analyzeWebsite scraper extension"
```

---

### Task A8: Port `strategicPathSchema`

**Files:**
- Create: `apps/web/src/lib/strategic-path-schema.ts`

- [ ] **Step 1: Extract the strategic-path subset from `src/tools/schemas.ts`**

Read `src/tools/schemas.ts` (search for `strategicPathSchema`, `strategicMilestoneSchema`, `strategicThesisWeekSchema`, `strategicChannelSettingsSchema`, `strategicThesisWeekPostsSchema`). Copy ALL of those Zod schema declarations into `apps/web/src/lib/strategic-path-schema.ts` and export them. Do not include `planItemInputSchema` or anything below — onboarding doesn't need those.

Skeleton:

```typescript
import { z } from "zod";

// ... (paste milestone, thesisWeekPosts, thesisWeek, channelSettings schemas) ...

export const strategicPathSchema = z.object({
  narrative: z.string().min(200).max(2400),
  milestones: z.array(strategicMilestoneSchema).min(3).max(12),
  thesisArc: z.array(strategicThesisWeekSchema).min(1).max(12),
  contentPillars: z.array(z.string().min(1).max(60)).min(3).max(4),
  channelMix: z
    .object({
      x: strategicChannelSettingsSchema.nullish(),
      reddit: strategicChannelSettingsSchema.nullish(),
      email: strategicChannelSettingsSchema.nullish(),
    })
    .refine((c) => Object.values(c).some((v) => v != null), {
      message: "channelMix must include at least one active channel",
    }),
  phaseGoals: z.object({
    foundation: z.string().min(1).max(240).nullish(),
    audience: z.string().min(1).max(240).nullish(),
    momentum: z.string().min(1).max(240).nullish(),
    launch: z.string().min(1).max(240).nullish(),
    compound: z.string().min(1).max(240).nullish(),
    steady: z.string().min(1).max(240).nullish(),
  }),
});

export type StrategicPath = z.infer<typeof strategicPathSchema>;
export type StrategicMilestone = z.infer<typeof strategicMilestoneSchema>;
export type StrategicChannelSettings = z.infer<typeof strategicChannelSettingsSchema>;
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`

Expected: 0 errors related to `strategic-path-schema.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/strategic-path-schema.ts
git commit -m "feat(web): port strategicPathSchema for onboarding"
```

---

### Task A9: Add `github.ts` (OAuth token + repo APIs)

**Files:**
- Create: `apps/web/src/lib/github.ts`

- [ ] **Step 1: Write the module**

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { account, eq, and } from "@shipflare/db";
import { drizzle } from "drizzle-orm/d1";

export interface GithubRepo {
  fullName: string;
  name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazersCount: number;
  pushedAt: string;
}

export async function getGitHubToken(
  d1: D1Database,
  userId: string,
): Promise<string | null> {
  const db = drizzle(d1);
  const row = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .get();
  return row?.accessToken ?? null;
}

export async function listUserRepos(token: string): Promise<GithubRepo[]> {
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipFlare/1.0",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  }
  const repos = (await res.json()) as Array<{
    full_name: string;
    name: string;
    description: string | null;
    homepage: string | null;
    language: string | null;
    stargazers_count: number;
    pushed_at: string;
  }>;
  return repos.map((r) => ({
    fullName: r.full_name,
    name: r.name,
    description: r.description,
    homepage: r.homepage,
    language: r.language,
    stargazersCount: r.stargazers_count,
    pushedAt: r.pushed_at,
  }));
}

export async function getRepoReadme(
  token: string,
  fullName: string,
): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "User-Agent": "ShipFlare/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub README ${res.status}`);
  }
  return await res.text();
}
```

- [ ] **Step 2: Re-export `account` from `@shipflare/db` if not already**

Run: `grep "export.*account\b" packages/db/src/index.ts`

If missing, add `account` to the existing schema re-export line.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/github.ts packages/db/src/index.ts
git commit -m "feat(web): github oauth token + repo APIs"
```

---

### Task A10: Add `types/onboarding.ts`

**Files:**
- Create: `apps/web/src/lib/types/onboarding.ts`

- [ ] **Step 1: Copy `src/types/onboarding.ts` verbatim**

```typescript
export interface ExtractedProfile {
  url: string;
  name: string;
  description: string;
  keywords: string[];
  valueProp: string;
  targetAudience: string;
  ogImage: string | null;
  seoAudit: Record<string, unknown> | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/types/onboarding.ts
git commit -m "feat(web): ExtractedProfile type"
```

---

## Phase B — API Routes

### Task B1: `/api/onboarding/draft` GET/PUT/DELETE

**Files:**
- Create: `apps/web/app/api/onboarding/draft/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { getDraft, putDraft, deleteDraft, type OnboardingDraft } from "@/lib/onboarding-draft";

export const dynamic = "force-dynamic";

async function requireUser(req: Request): Promise<string | Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session.user.id;
}

export async function GET(req: Request): Promise<Response> {
  const userOrResp = await requireUser(req);
  if (userOrResp instanceof Response) return userOrResp;
  const { env } = getCloudflareContext();
  const draft = await getDraft(env.DB, userOrResp);
  return NextResponse.json({ draft });
}

export async function PUT(req: Request): Promise<Response> {
  const userOrResp = await requireUser(req);
  if (userOrResp instanceof Response) return userOrResp;
  const { env } = getCloudflareContext();
  let patch: Partial<OnboardingDraft>;
  try {
    patch = (await req.json()) as Partial<OnboardingDraft>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const next = await putDraft(env.DB, userOrResp, patch);
  return NextResponse.json({ draft: next });
}

export async function DELETE(req: Request): Promise<Response> {
  const userOrResp = await requireUser(req);
  if (userOrResp instanceof Response) return userOrResp;
  const { env } = getCloudflareContext();
  await deleteDraft(env.DB, userOrResp);
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Smoke-test type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/onboarding/draft/route.ts
git commit -m "feat(web): /api/onboarding/draft route"
```

---

### Task B2: `/api/onboarding/extract` (URL → profile)

**Files:**
- Create: `apps/web/app/api/onboarding/extract/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { scrapeWebsite, analyzeWebsite } from "@/lib/scraper";
import { auditSeo } from "@/lib/seo-audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }
  const { env } = getCloudflareContext();
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return NextResponse.json({ error: "anthropic_not_configured" }, { status: 503 });
  }
  const scraped = await scrapeWebsite(body.url);
  const [analysis, seoAudit] = await Promise.all([
    analyzeWebsite(scraped, anthropicKey),
    auditSeo(body.url),
  ]);
  return NextResponse.json({
    url: body.url,
    name: analysis.productName,
    description: analysis.oneLiner,
    keywords: analysis.keywords,
    valueProp: analysis.valueProp,
    targetAudience: analysis.targetAudience,
    ogImage: scraped.ogImage,
    seoAudit,
  });
}
```

- [ ] **Step 2: Verify `ANTHROPIC_API_KEY` is declared in `apps/web/src/env.d.ts`**

Read `apps/web/src/env.d.ts`. If `ANTHROPIC_API_KEY` is not declared, add it to the CloudflareEnv interface:

```typescript
interface CloudflareEnv {
  // ... existing bindings ...
  ANTHROPIC_API_KEY?: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/onboarding/extract/route.ts apps/web/src/env.d.ts
git commit -m "feat(web): /api/onboarding/extract URL profile route"
```

---

### Task B3: `/api/onboarding/github-repos`

**Files:**
- Create: `apps/web/app/api/onboarding/github-repos/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { getGitHubToken, listUserRepos } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { env } = getCloudflareContext();
  const token = await getGitHubToken(env.DB, session.user.id);
  if (!token) {
    return NextResponse.json({ error: "No GitHub account linked" }, { status: 404 });
  }
  try {
    const repos = await listUserRepos(token);
    return NextResponse.json({ repos, username: session.user.name ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch repos";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/api/onboarding/github-repos/route.ts
git commit -m "feat(web): /api/onboarding/github-repos route"
```

---

### Task B4: `/api/onboarding/extract-repo` (README-based, SSE)

**Files:**
- Create: `apps/web/app/api/onboarding/extract-repo/route.ts`

- [ ] **Step 1: Write the SSE route**

```typescript
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { getGitHubToken, getRepoReadme } from "@/lib/github";
import { getAnthropic, type ProductAnalysis } from "@/lib/anthropic";

export const dynamic = "force-dynamic";

const ANALYZE_PROMPT = `You analyze GitHub repositories to understand what product they offer.
Given the README content below, extract:

1. productName — the actual product name (not the org/owner)
2. oneLiner — one sentence describing what it does
3. targetAudience — who this is for (be specific)
4. keywords — 5-8 topic keywords a potential user would search for (lowercase)
5. valueProp — the core value proposition in one sentence

Respond with ONLY a JSON object:
{"productName":"...","oneLiner":"...","targetAudience":"...","keywords":["..."],"valueProp":"..."}`;

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { repoFullName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.repoFullName || !/^[\w.-]+\/[\w.-]+$/.test(body.repoFullName)) {
    return NextResponse.json({ error: "Invalid repo format" }, { status: 400 });
  }
  const repoFullName = body.repoFullName;
  const { env } = getCloudflareContext();
  const token = await getGitHubToken(env.DB, session.user.id);
  if (!token) {
    return NextResponse.json({ error: "No GitHub account linked" }, { status: 404 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "anthropic_not_configured" }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        send({ type: "progress", phase: "fetching_readme" });
        const readme = await getRepoReadme(token, repoFullName);
        send({ type: "progress", phase: "analyzing" });
        const client = getAnthropic(env.ANTHROPIC_API_KEY!);
        const response = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          system: ANALYZE_PROMPT,
          messages: [
            {
              role: "user",
              content: `Repo: github.com/${repoFullName}\n\nREADME:\n${readme.slice(0, 50_000)}`,
            },
          ],
        });
        const text =
          response.content[0]?.type === "text" ? response.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in response");
        const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
        send({
          type: "complete",
          profile: {
            url: `https://github.com/${repoFullName}`,
            name: parsed.productName ?? repoFullName.split("/")[1],
            description: parsed.oneLiner ?? "",
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
            valueProp: parsed.valueProp ?? "",
            targetAudience: parsed.targetAudience ?? "",
            ogImage: null,
            seoAudit: null,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/api/onboarding/extract-repo/route.ts
git commit -m "feat(web): /api/onboarding/extract-repo (README + Anthropic)"
```

---

### Task B5: `/api/onboarding/plan` (SSE StrategicPath generation)

**Files:**
- Create: `apps/web/app/api/onboarding/plan/route.ts`

- [ ] **Step 1: Write the SSE route**

This route does ONE Anthropic call with structured output. No tool loop. The Railway version used a multi-turn skill; v1 collapses it to a single structured-output call. The schema is validated server-side.

```typescript
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { getAuth } from "@/auth";
import { getAnthropic } from "@/lib/anthropic";
import {
  strategicPathSchema,
  type StrategicPath,
} from "@/lib/strategic-path-schema";
import { derivePhase } from "@/lib/launch-phase";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const HEARTBEAT_INTERVAL_MS = 15_000;
const TIMEOUT_MS = 180_000;

const requestBodySchema = z.object({
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    valueProp: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20),
    category: z.enum([
      "dev_tool",
      "saas",
      "consumer",
      "creator_tool",
      "agency",
      "ai_app",
      "other",
    ]),
    targetAudience: z.string().max(600).nullable().optional(),
  }),
  channels: z.array(z.enum(["x", "reddit", "email"])).min(1),
  state: z.enum(["mvp", "launching", "launched"]),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  launchChannel: z.enum(["producthunt", "showhn", "both", "other"]).nullable().optional(),
  usersBucket: z.enum(["<100", "100-1k", "1k-10k", "10k+"]).nullable().optional(),
});

type RequestBody = z.infer<typeof requestBodySchema>;

const SYSTEM_PROMPT = `You are the Head of Growth for an indie product. Produce a 30-day marketing strategy as a strict JSON object matching this Zod-style shape:

{
  "narrative": string (200-2400 chars, 2-3 paragraphs explaining the strategic thesis),
  "milestones": Array<{ title: string, summary: string, dueOffsetDays: number }>, // 3-12 items
  "thesisArc": Array<{
    weekStart: string (YYYY-MM-DD, Monday UTC),
    theme: string,
    posts: { x?: number, reddit?: number, email?: number }
  }>, // 1-12 weeks
  "contentPillars": string[] (3-4 short labels),
  "channelMix": {
    "x"?: { cadencePerWeek: number, repliesPerDay?: number },
    "reddit"?: { cadencePerWeek: number },
    "email"?: { cadencePerWeek: number }
  } (at least one channel non-null, matching connected channels),
  "phaseGoals": {
    "foundation"?: string, "audience"?: string, "momentum"?: string,
    "launch"?: string, "compound"?: string, "steady"?: string
  } (at least the entry matching currentPhase is set)
}

Anchor thesisArc[0].weekStart at the Monday 00:00 UTC of the week containing today.
Tailor channelMix to ONLY the channels passed in input.channels.
Respond with ONLY the JSON object, no surrounding prose.`;

function isoMondayUTC(d: Date): string {
  const date = new Date(d);
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: RequestBody;
  try {
    body = requestBodySchema.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid body";
    return NextResponse.json({ error: "invalid_request", detail }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  if (!env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "anthropic_not_configured" }, { status: 503 });
  }

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const currentPhase = derivePhase({ state: body.state, launchDate, launchedAt });
  const today = new Date();
  const weekStart = isoMondayUTC(today);

  const userMessage = JSON.stringify(
    {
      today: today.toISOString().slice(0, 10),
      weekStart,
      product: body.product,
      state: body.state,
      currentPhase,
      channels: body.channels,
      launchDate: body.launchDate ?? null,
      launchedAt: body.launchedAt ?? null,
      launchChannel: body.launchChannel ?? null,
      usersBucket: body.usersBucket ?? null,
    },
    null,
    2,
  );

  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // controller closed by client
        }
      };
      const cleanup = (terminal: Record<string, unknown>) => {
        if (closed) return;
        send(terminal);
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (timeoutId) clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
      timeoutId = setTimeout(() => abortController.abort(), TIMEOUT_MS);

      try {
        const client = getAnthropic(env.ANTHROPIC_API_KEY!);
        const response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
          },
          { signal: abortController.signal },
        );
        const text =
          response.content[0]?.type === "text" ? response.content[0].text : "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          cleanup({ type: "error", error: "no_json_in_response" });
          return;
        }
        const raw = JSON.parse(jsonMatch[0]);
        const path: StrategicPath = strategicPathSchema.parse(raw);
        cleanup({ type: "strategic_done", path });
      } catch (err) {
        if (abortController.signal.aborted) {
          cleanup({ type: "error", error: "planner_timeout" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`onboarding/plan failed user=${userId}:`, message);
        cleanup({ type: "error", error: "PlanGenerationError" });
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (timeoutId) clearTimeout(timeoutId);
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/onboarding/plan/route.ts
git commit -m "feat(web): /api/onboarding/plan SSE strategic-path generator"
```

---

### Task B6: `/api/onboarding/commit`

**Files:**
- Create: `apps/web/app/api/onboarding/commit/route.ts`

- [ ] **Step 1: Inspect existing CMO RPC binding mechanism**

Read `apps/web/src/auth.ts` and look for any `env.CORE.fetch(...)` or `env.CMO.idFromName(...)` calls. Whichever mechanism is already in use (Service Binding via CORE or direct DO namespace via CMO), use the same in the commit route.

Run: `grep -n "env\.\(CORE\|CMO\)" apps/web/src/auth.ts apps/web/src/lib/*.ts apps/web/app/api/*/route.ts 2>/dev/null`

Note the exact pattern used and apply it below.

- [ ] **Step 2: Write the route**

```typescript
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { eq, products } from "@shipflare/db";
import { getDb } from "@/db";
import { getAuth } from "@/auth";
import { strategicPathSchema } from "@/lib/strategic-path-schema";
import { derivePhase } from "@/lib/launch-phase";
import { validateLaunchDates } from "@/lib/launch-date-rules";
import { deleteDraft } from "@/lib/onboarding-draft";

export const dynamic = "force-dynamic";

const requestBodySchema = z.object({
  product: z.object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    valueProp: z.string().max(600).nullable().optional(),
    keywords: z.array(z.string().min(1)).max(20),
    category: z.enum([
      "dev_tool",
      "saas",
      "consumer",
      "creator_tool",
      "agency",
      "ai_app",
      "other",
    ]),
    targetAudience: z.string().max(600).nullable().optional(),
    url: z.string().url().nullable().optional(),
  }),
  state: z.enum(["mvp", "launching", "launched"]),
  launchDate: z.string().datetime().nullable().optional(),
  launchedAt: z.string().datetime().nullable().optional(),
  launchChannel: z.enum(["producthunt", "showhn", "both", "other"]).nullable().optional(),
  usersBucket: z.enum(["<100", "100-1k", "1k-10k", "10k+"]).nullable().optional(),
  path: strategicPathSchema,
});

type RequestBody = z.infer<typeof requestBodySchema>;

export async function POST(req: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: RequestBody;
  try {
    body = requestBodySchema.parse(await req.json());
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid body";
    return NextResponse.json({ error: "invalid_request", detail }, { status: 400 });
  }

  const dateErrors = validateLaunchDates({
    state: body.state,
    launchDate: body.launchDate ?? null,
    launchedAt: body.launchedAt ?? null,
  });
  if (dateErrors.length > 0) {
    return NextResponse.json(
      { error: "invalid_dates", detail: dateErrors },
      { status: 400 },
    );
  }

  const launchDate = body.launchDate ? new Date(body.launchDate) : null;
  const launchedAt = body.launchedAt ? new Date(body.launchedAt) : null;
  const _phase = derivePhase({ state: body.state, launchDate, launchedAt });
  const now = new Date();

  const { env } = getCloudflareContext();
  const db = getDb(env);

  try {
    const existing = await db
      .select()
      .from(products)
      .where(eq(products.userId, userId))
      .get();

    const merged = {
      userId,
      name: body.product.name,
      description: body.product.description,
      valueProp: body.product.valueProp ?? null,
      keywords: body.product.keywords,
      url: body.product.url ?? null,
      category: body.product.category,
      targetAudience: body.product.targetAudience ?? null,
      state: body.state,
      launchDate,
      launchedAt,
      launchChannel: body.launchChannel ?? null,
      usersBucket: body.usersBucket ?? null,
      onboardingCompletedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await db
      .insert(products)
      .values(merged)
      .onConflictDoUpdate({
        target: products.userId,
        set: {
          name: merged.name,
          description: merged.description,
          valueProp: merged.valueProp,
          keywords: merged.keywords,
          url: merged.url,
          category: merged.category,
          targetAudience: merged.targetAudience,
          state: merged.state,
          launchDate: merged.launchDate,
          launchedAt: merged.launchedAt,
          launchChannel: merged.launchChannel,
          usersBucket: merged.usersBucket,
          onboardingCompletedAt: merged.onboardingCompletedAt,
          updatedAt: merged.updatedAt,
        },
      });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`commit product upsert failed user=${userId}:`, message);
    return NextResponse.json({ error: "commit_failed", detail: message }, { status: 500 });
  }

  // Best-effort: ship the strategic path to CMO DO via service binding.
  // Non-fatal — if this fails, the founder can re-generate from /settings.
  try {
    const initRes = await env.CORE.fetch(
      `https://internal/agents/cmo/${encodeURIComponent(userId)}/internal/commit-strategic-path`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shipflare-internal": "1",
        },
        body: JSON.stringify({
          theme: body.path.contentPillars[0] ?? "Launch",
          narrative: body.path,
          generatedBy: "onboarding",
        }),
      },
    );
    if (!initRes.ok) {
      console.warn(
        `commit: CMO commit-strategic-path returned ${initRes.status} for ${userId}`,
      );
    }
  } catch (err) {
    console.warn(
      `commit: CMO commit-strategic-path threw for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Clear the draft (idempotent).
  try {
    await deleteDraft(env.DB, userId);
  } catch (err) {
    console.warn(
      `commit: deleteDraft failed for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({
    success: true,
    conversationId: null,
  });
}
```

- [ ] **Step 3: Add the CMO internal route**

Inspect `apps/core/src/agents/cmo/CMO.ts` and find the existing `internal/*` route handler. Add a new POST handler for `/internal/commit-strategic-path` that calls the existing `commitStrategicPath` tool inline (no MCP round-trip).

Read: `grep -n "internal\|onRequest\|fetch" apps/core/src/agents/cmo/CMO.ts | head -20`

If the CMO has an `onRequest` method or a route table, add the handler there. The handler should:
1. Parse `{ theme, narrative, generatedBy }` from the request body
2. Run the same SQL INSERT the `commitStrategicPath` MCP tool does (look at `apps/core/src/agents/cmo/tools/shared-state.ts` lines 67-105 for the exact SQL)
3. Return `{ id, version }` as JSON

Concretely, the handler shape:

```typescript
// inside CMO.onRequest or equivalent, branch on path
if (url.pathname.endsWith("/internal/commit-strategic-path") && request.method === "POST") {
  if (request.headers.get("x-shipflare-internal") !== "1") {
    return new Response("forbidden", { status: 403 });
  }
  const body = await request.json() as { theme: string; narrative: Record<string, unknown>; generatedBy: string };
  const id = crypto.randomUUID();
  const latest = this.sqlStorage
    .exec<{ v: number }>("SELECT COALESCE(MAX(version), 0) as v FROM strategic_path")
    .one();
  const version = latest.v + 1;
  this.sqlStorage.exec(
    `INSERT INTO strategic_path
       (id, version, theme, narrative_json, status, generated_at, generated_by)
     VALUES (?, ?, ?, ?, 'pending_approval', ?, ?)`,
    id, version, body.theme, JSON.stringify(body.narrative), Date.now(), body.generatedBy,
  );
  return new Response(JSON.stringify({ id, version }), {
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 4: Type-check**

Run from repo root: `pnpm tsc --noEmit --pretty false`

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/onboarding/commit/route.ts apps/core/src/agents/cmo/CMO.ts
git commit -m "feat(commit): onboarding commit + CMO internal commit-strategic-path"
```

---

## Phase C — UI Components

### Task C1: Copy all onboarding components

**Files:**
- Create: `apps/web/app/onboarding/_components/*` (22+ files)
- Delete: `apps/web/app/onboarding/_components/onboarding-form.tsx`

- [ ] **Step 1: Copy the whole directory tree**

```bash
rm /Users/yifeng/Documents/Code/shipflare/apps/web/app/onboarding/_components/onboarding-form.tsx
cp -R /Users/yifeng/Documents/Code/shipflare/src/components/onboarding/* /Users/yifeng/Documents/Code/shipflare/apps/web/app/onboarding/_components/
```

Verify file list:

```bash
ls apps/web/app/onboarding/_components/
ls apps/web/app/onboarding/_components/_shared/
```

Both should match the Railway tree exactly (22+ files, including OnboardingFlow.tsx, stage-*.tsx, _shared/*).

- [ ] **Step 2: Remove the `__tests__/` directories**

```bash
rm -rf apps/web/app/onboarding/_components/__tests__
rm -rf apps/web/app/onboarding/_components/_shared/__tests__
```

Reason: the tests reference Railway-specific test setup paths. Re-add equivalent tests later if needed.

- [ ] **Step 3: Commit (initial copy, broken imports expected)**

```bash
git add apps/web/app/onboarding/_components/
git commit -m "chore(web): copy railway onboarding components verbatim (imports broken)"
```

---

### Task C2: Rewire imports

**Files:**
- Modify: every file under `apps/web/app/onboarding/_components/`

- [ ] **Step 1: Bulk rewrite the imports**

Run the following sed commands (mac BSD sed; use `sed -i ''` syntax). Run from the repo root:

```bash
cd /Users/yifeng/Documents/Code/shipflare
find apps/web/app/onboarding/_components -name '*.tsx' -o -name '*.ts' | xargs sed -i '' \
  -e "s|from '@/types/onboarding'|from '@/lib/types/onboarding'|g" \
  -e "s|from '@/tools/schemas'|from '@/lib/strategic-path-schema'|g"
```

- [ ] **Step 2: Inspect for any remaining stale imports**

Run: `grep -rn "from '@/\(types\|tools\|skills\|core\|services\|memory\|engine\)" apps/web/app/onboarding/_components/`

Expected: no matches. If there are matches, deal with each manually:
- `@/lib/auth` → `@/auth`
- `@/lib/db` → `@/db`
- `@/lib/logger` → drop the import and replace `log.xxx(...)` with `console.xxx(...)`

Iterate until grep returns empty.

- [ ] **Step 3: Type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Address each error. Common issues:
- Missing peer types from `@/lib/strategic-path-schema` — re-export anything the components import.
- React 19 type strictness — add explicit return types if `tsc` complains.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/onboarding/_components/
git commit -m "chore(web): rewire onboarding component imports for apps/web"
```

---

### Task C3: Replace `apps/web/app/onboarding/page.tsx` with the OnboardingFlow shell

**Files:**
- Modify: `apps/web/app/onboarding/page.tsx`
- Modify: `apps/web/app/onboarding/layout.tsx`

- [ ] **Step 1: Update `page.tsx`**

Replace the whole file with:

```typescript
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { products, eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { OnboardingFlow } from "./_components/OnboardingFlow";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Onboarding — ShipFlare",
};

export default async function OnboardingPage() {
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    session = null;
  }
  if (!session?.user) redirect("/");

  const { env } = getCloudflareContext();
  const db = getDb(env);
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  // If onboarding has already been completed, skip the flow.
  if (existing?.onboardingCompletedAt) {
    redirect("/briefing");
  }

  return <OnboardingFlow />;
}
```

- [ ] **Step 2: Update `layout.tsx` to full-bleed**

Replace the whole file with:

```typescript
import type { ReactNode } from "react";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: "100vh", background: "var(--sf-bg-primary)" }}>{children}</div>;
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/web && pnpm tsc --noEmit --pretty false`

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/onboarding/page.tsx apps/web/app/onboarding/layout.tsx
git commit -m "feat(web): swap onboarding-form for full 7-stage OnboardingFlow"
```

---

## Phase D — Wire-up + Verification

### Task D1: Update Better Auth GitHub scope

**Files:**
- Modify: `apps/web/src/auth.ts`

- [ ] **Step 1: Locate the GitHub provider config**

Read `apps/web/src/auth.ts` and find the `github: { ... }` provider block.

- [ ] **Step 2: Add `scope: ["read:user", "user:email", "public_repo"]`**

Change the GitHub block to (preserving any existing fields):

```typescript
github: {
  clientId: env.GITHUB_CLIENT_ID!,
  clientSecret: env.GITHUB_CLIENT_SECRET!,
  scope: ["read:user", "user:email", "public_repo"],
},
```

If `scope` is already present, append `"public_repo"` to it. If the user has a private repo they want to onboard, they'll need `repo` — but `public_repo` keeps the scope tighter and covers the 90% case.

- [ ] **Step 3: Document the re-auth requirement**

Append a short note to `handoff.md` under "Known Issues":

```
- Existing GitHub-linked users must re-sign-in once after this change to pick up the public_repo scope. Better Auth doesn't auto-upgrade scopes.
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/auth.ts handoff.md
git commit -m "feat(web): request public_repo GitHub scope for onboarding"
```

---

### Task D2: Add `ANTHROPIC_API_KEY` documentation

**Files:**
- Modify: `scripts/cf-deploy-checklist.md` (if it exists) or `handoff.md`

- [ ] **Step 1: Document the secret**

If `scripts/cf-deploy-checklist.md` exists, append to the secrets section:

```
- `ANTHROPIC_API_KEY` — required by /api/onboarding/extract, /api/onboarding/extract-repo, /api/onboarding/plan. Set on apps/web ONLY.
```

Otherwise add to `handoff.md` under "Prerequisites Before Testing":

```
### Step 1.5 — Set ANTHROPIC_API_KEY on apps/web

cd apps/web
pnpm exec wrangler secret put ANTHROPIC_API_KEY
# paste the key when prompted
```

- [ ] **Step 2: Commit**

```bash
git add scripts/cf-deploy-checklist.md handoff.md 2>/dev/null || git add handoff.md
git commit -m "docs: ANTHROPIC_API_KEY required for onboarding routes"
```

---

### Task D3: Run the dev server and walk through the flow

**Files:**
- None (verification only)

- [ ] **Step 1: Start the dev server**

```bash
cd apps/web && pnpm dev
```

- [ ] **Step 2: Open the onboarding page**

Open `http://localhost:3000/onboarding` in a browser. You should see Stage 1 (Source picker).

- [ ] **Step 3: Walk the URL path**

1. Click "Continue with a URL"
2. Enter `https://example.com`
3. Stage 2 (Scanning) animation runs
4. Stage 3 (Review) appears with extracted fields
5. Click "Looks good"
6. Stage 4 (Connect) — verify X / Reddit / email cards render
7. Click "Continue"
8. Stage 5 (State) — pick "Launching", set a future date
9. Click "Generate plan"
10. Stage 6 (Plan-building) animation runs
11. Stage 7 (Plan) renders the strategic path
12. Click "Looks good, let's start"
13. Redirects to `/briefing` (or `/team` per Railway behaviour — confirm which one)

- [ ] **Step 4: Check D1 state**

```bash
cd apps/web
pnpm exec wrangler d1 execute shipflare-prod --local --command "SELECT userId, name, category, state, launchDate, onboardingCompletedAt FROM products"
pnpm exec wrangler d1 execute shipflare-prod --local --command "SELECT userId, length(payload) AS payload_len, updatedAt FROM onboarding_drafts"
```

Expected: one row in `products` with the onboarded values; zero rows in `onboarding_drafts` (cleaned up by commit).

- [ ] **Step 5: Check CMO DO state**

Trigger a CMO request (e.g. open `/chat`) and then:

```bash
cd apps/core
pnpm exec wrangler tail | grep strategic_path
```

After the page loads, observe whether `commitStrategicPath` was logged.

If you have direct access to DO storage via wrangler, inspect `strategic_path` rows. Otherwise document the gap in `handoff.md` for the next session.

- [ ] **Step 6: Run all unit tests**

```bash
cd /Users/yifeng/Documents/Code/shipflare
pnpm -r vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Type-check the monorepo**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: 0 errors.

---

## Phase E — Real-browser Smoke Test (Playwright)

### Task E1: Playwright happy-path E2E

**Files:**
- Create: `apps/web/test/e2e/onboarding-flow.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
import { test, expect } from "@playwright/test";

// This test requires:
//   1. apps/web running on http://localhost:3000
//   2. A pre-authenticated session (user already signed in)
//   3. No existing onboardingCompletedAt for the test user
//
// Skip in CI if no auth context is available.

test.describe("onboarding-flow", () => {
  test("URL path — Stage 1 to Stage 7 to /briefing", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page.locator("text=Get started")).toBeVisible({ timeout: 5_000 });

    // Stage 1: URL method
    await page.getByRole("button", { name: /Continue with a URL/i }).click();
    await page.getByPlaceholder(/yourproduct\.com|https?/i).fill("https://example.com");
    await page.getByRole("button", { name: /Scan|Continue/i }).click();

    // Stage 2: scanning animation; wait for Stage 3 review fields
    await expect(page.getByLabel(/Product name/i)).toBeVisible({ timeout: 60_000 });

    // Stage 3
    await page.getByLabel(/Product name/i).fill("Example Co");
    await page.getByRole("button", { name: /Looks good|Continue/i }).click();

    // Stage 4: Connect — skip without connecting
    await page.getByRole("button", { name: /Skip|Continue/i }).click();

    // Stage 5: State
    await page.getByRole("button", { name: /Launching/i }).click();
    // pick date ~30 days from now
    const target = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel(/Launch date/i).fill(target);
    await page.getByRole("button", { name: /Generate plan/i }).click();

    // Stage 6: plan-building; wait for plan
    await expect(page.getByText(/Pillars|Thesis|Plan/i).first()).toBeVisible({
      timeout: 180_000,
    });

    // Stage 7
    await page.getByRole("button", { name: /Looks good|Start|Commit/i }).click();

    // Redirect lands on /briefing
    await expect(page).toHaveURL(/\/briefing/, { timeout: 10_000 });
  });
});
```

- [ ] **Step 2: Run Playwright**

```bash
cd apps/web && pnpm exec playwright test test/e2e/onboarding-flow.spec.ts --headed
```

The test will fail if no auth context is set up. Document the auth requirement in the test header and skip-mark in CI.

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/e2e/onboarding-flow.spec.ts
git commit -m "test(web): playwright happy-path for onboarding flow"
```

---

## Self-Review Punch List

- [ ] **Spec coverage:**
  - Stage 1 source picker → Tasks B3, B4, C1, C2 ✓
  - Stage 2 scanning → Task B2 + B4 ✓
  - Stage 3 review → Tasks C1, C2 (component) ✓
  - Stage 4 connect → reuses existing `/api/channels/*` ✓
  - Stage 5 state → Tasks A2, A3 (libs) + components ✓
  - Stage 6 plan-building → Task B5 (SSE) ✓
  - Stage 7 plan review → Task B6 (commit) ✓
  - Draft persistence → A1 (schema) + A4 (lib) + B1 (route) ✓
  - Scraping → A5 + A7 ✓
  - SEO audit → A6 ✓
  - GitHub OAuth + repos → A9 + D1 ✓
  - StrategicPath storage → CMO RPC in B6 ✓
  - Type safety end-to-end → enforced at A8 + verified at every type-check step ✓

- [ ] **Gaps acknowledged (not blockers for v1):**
  - Onboarding-time team provisioning (Railway's `provisionTeamForProduct`): CMO DO auto-initializes on first sign-in; we rely on that.
  - Reddit channel research queue: not present on CF. Stage 4 surfaces Reddit as always-on no-binding (matches `feedback_engine_primitives_no_orchestrator` and CLAUDE.md).
  - `plan_items` insertion after commit: Railway runs a tactical-planner team-run; CF defers tactical planning to the user's first `/team` visit (kickoff path). Confirmed acceptable per current CF behavior.
  - Code-scanner (Railway BullMQ pipeline) replaced with README-only fetch (B4). Repo cloning + analysis is out of scope.

- [ ] **Architectural decisions locked:**
  - Draft store: D1 table `onboarding_drafts` (not KV).
  - Plan generation: single Anthropic structured-output call in the route, not the full `generating-strategy` skill loop.
  - Strategic path canonical: CMO DO SQLite via internal RPC route.
  - GitHub scope: `public_repo` (private repos out of scope for v1).
  - Products state enum: align to Railway (`mvp/launching/launched`) — breaks existing CF columns; A1 migration coerces stale values.

---

## Execution Notes

Each task above commits at its end. After Phase A completes, run the full monorepo tsc + vitest. After Phase B completes, run the same. After Phase C completes, the onboarding page should load (even if some flows are visually broken). After Phase D, the entire flow is wired. Phase E is verification.

**Recommended cadence:** dispatch Phase A subagents in parallel (A2/A3/A6/A10 are fully independent; A4 depends on A1; A7 depends on A5; A9 depends on A1 re-exports). Phases B/C/D are mostly sequential — each task tends to depend on the previous one.
