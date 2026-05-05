# Briefing redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `/today` and `/calendar` into a new `/briefing` route with two tabs (Today / Plan), surface a permanent `BriefingHeader` so an empty inbox post-kickoff never reads as "today shows nothing," and rename the parent surface to carry the founder/boss frame.

**Architecture:** New `briefing/` route owns a tab nav + header shell; the Today tab body is extracted from `today-content.tsx` (header strip removed) so both `/briefing` and the legacy `/today` can render the same cards during the migration window. The Plan tab embeds the existing `<CalendarContent />` unchanged. One new endpoint (`/api/briefing/summary`) feeds the header. Old paths 301-redirect, in-app references repointed.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Drizzle ORM, SWR, Vitest 4 with happy-dom for component tests, Playwright for live-smoke.

**Spec:** `docs/superpowers/specs/2026-05-03-briefing-redesign-design.md`

---

## File map

Created:
- `src/app/api/briefing/summary/route.ts`
- `src/app/api/briefing/__tests__/summary-route.test.ts`
- `src/app/(app)/briefing/layout.tsx`
- `src/app/(app)/briefing/page.tsx`
- `src/app/(app)/briefing/plan/page.tsx`
- `src/app/(app)/briefing/_components/briefing-header.tsx`
- `src/app/(app)/briefing/_components/tab-nav.tsx`
- `src/app/(app)/briefing/_components/today-tab.tsx`
- `src/app/(app)/briefing/_components/plan-tab.tsx`
- `src/app/(app)/briefing/_components/__tests__/briefing-header.test.tsx`
- `src/app/(app)/briefing/_components/__tests__/tab-nav.test.tsx`
- `e2e/tests/briefing-tabs.live-smoke.ts`

Modified:
- `src/app/(app)/today/today-content.tsx` — extract `<TodayBody>` (the body sections without HeaderBar / WelcomeRibbon / TacticalProgressCard).
- `src/app/(app)/today/_components/post-card.tsx` — add provenance byline.
- `src/app/(app)/today/_components/reply-card.tsx` — add provenance byline.
- `src/components/layout/nav-items.ts` — point Today + Calendar entries at `/briefing` and `/briefing/plan`.
- `src/components/layout/sidebar.tsx` — same.
- `src/app/(app)/error.tsx`, `src/app/not-found.tsx`, `src/app/(app)/not-found.tsx` — repoint `href="/today"` to `/briefing`.
- `src/app/actions/auth.ts` — `redirectTo: '/briefing'`.
- `src/lib/oauth-return.ts` — `DEFAULT_OAUTH_RETURN = '/briefing'`.
- `src/components/marketing/hero-demo.tsx`, `cta-section.tsx`, `glass-nav.tsx` — repoint to `/briefing`.
- `src/app/(app)/team/_components/onboarding-banner.tsx` — copy update + link to `/briefing`.
- `next.config.ts` — add 301 redirects for `/today` → `/briefing` and `/calendar` → `/briefing/plan`.

Untouched (intentionally — guarantees blast radius stays bounded):
- `src/app/api/today/route.ts`
- `src/app/api/calendar/route.ts`
- `src/app/(app)/calendar/calendar-content.tsx` (consumed as-is by `plan-tab.tsx`)
- `src/lib/calendar-layout.ts`
- `src/hooks/use-today.ts`
- `src/lib/db/schema/*` (no schema changes)
- All worker processors

## Conventions confirmed in-repo

- Tests live under `src/**/__tests__/**/*.test.ts(x)` per `vitest.config.ts`. Do **not** colocate tests next to source.
- React component tests start with `// @vitest-environment happy-dom` and use `@testing-library/react`'s `render` + `cleanup`.
- `pnpm test` runs `vitest run`. `pnpm test <path>` runs a single file.
- Build gate is `pnpm tsc --noEmit` (memory: vitest uses `isolatedModules`; tsc is the authoritative green). Always finish with `pnpm tsc --noEmit && pnpm build`.
- Commits follow `<type>(<scope>): <description>`. The repo disables trailer attribution via `~/.claude/settings.json` — **do not** add `Co-Authored-By` lines.
- Live-smoke specs use the `*.live-smoke.ts` suffix and live under `e2e/tests/`. They're skipped automatically when `.auth/founder.json` is missing.
- Week boundary helpers live in `src/lib/week-bounds.ts` (`weekBounds(now)` returns `{ weekStart, weekEnd }`). Reuse — do not re-derive.

---

## Task 1: New endpoint `/api/briefing/summary` (TDD)

**Files:**
- Create: `src/app/api/briefing/summary/route.ts`
- Create: `src/app/api/briefing/__tests__/summary-route.test.ts`

The endpoint aggregates `plan_items` for the authed user into the `BriefingSummary` shape from the spec. `nextDiscoveryAt` is `null` in v1 (the all-clear copy will fall back to a static string when null).

- [ ] **Step 1: Write the failing test**

Create `src/app/api/briefing/__tests__/summary-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

type AggregateRow = {
  todayAwaiting: number;
  todayShipped: number;
  todaySkipped: number;
  yesterdayShipped: number;
  yesterdaySkipped: number;
  weekQueued: number;
  weekShipped: number;
};

let aggregateRow: AggregateRow = {
  todayAwaiting: 0,
  todayShipped: 0,
  todaySkipped: 0,
  yesterdayShipped: 0,
  yesterdaySkipped: 0,
  weekQueued: 0,
  weekShipped: 0,
};
let onboardingCompletedAt: Date | null = null;

vi.mock('@/lib/db', () => {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve([{ onboardingCompletedAt }]),
    // The aggregate query returns a single row; we resolve directly.
    then: (cb: (rows: AggregateRow[]) => unknown) => cb([aggregateRow]),
  };
  return {
    db: {
      select: () => builder,
    },
  };
});

import { GET } from '../summary/route';

beforeEach(() => {
  authUserId = 'user-1';
  onboardingCompletedAt = null;
  aggregateRow = {
    todayAwaiting: 0,
    todayShipped: 0,
    todaySkipped: 0,
    yesterdayShipped: 0,
    yesterdaySkipped: 0,
    weekQueued: 0,
    weekShipped: 0,
  };
});

describe('GET /api/briefing/summary', () => {
  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns zeroed summary for a user with no plan_items', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      today: { awaiting: 0, shipped: 0, skipped: 0 },
      yesterday: { shipped: 0, skipped: 0 },
      thisWeek: { totalQueued: 0, totalShipped: 0 },
      isDay1: false,
      nextDiscoveryAt: null,
    });
  });

  it('passes aggregate counts straight through', async () => {
    aggregateRow = {
      todayAwaiting: 1,
      todayShipped: 2,
      todaySkipped: 1,
      yesterdayShipped: 3,
      yesterdaySkipped: 0,
      weekQueued: 6,
      weekShipped: 4,
    };
    const res = await GET();
    const body = await res.json();
    expect(body.today).toEqual({ awaiting: 1, shipped: 2, skipped: 1 });
    expect(body.yesterday).toEqual({ shipped: 3, skipped: 0 });
    expect(body.thisWeek).toEqual({ totalQueued: 6, totalShipped: 4 });
  });

  it('flags isDay1 when onboardingCompletedAt is within 24h', async () => {
    onboardingCompletedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const res = await GET();
    const body = await res.json();
    expect(body.isDay1).toBe(true);
  });

  it('does not flag isDay1 once 24h have elapsed', async () => {
    onboardingCompletedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const res = await GET();
    const body = await res.json();
    expect(body.isDay1).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm test src/app/api/briefing/__tests__/summary-route.test.ts
```

Expected: failure with `Cannot find module '../summary/route'`.

- [ ] **Step 3: Implement the route**

Create `src/app/api/briefing/summary/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { planItems, products } from '@/lib/db/schema';
import { weekBounds } from '@/lib/week-bounds';

export interface BriefingSummary {
  today: { awaiting: number; shipped: number; skipped: number };
  yesterday: { shipped: number; skipped: number };
  thisWeek: { totalQueued: number; totalShipped: number };
  isDay1: boolean;
  nextDiscoveryAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY_MS);
  return { start, end };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const now = new Date();
  const { start: todayStart, end: todayEnd } = dayBounds(now);
  const yStart = new Date(todayStart.getTime() - DAY_MS);
  const { weekStart, weekEnd } = weekBounds(now);

  // Convert to ISO strings — pg driver rejects raw Date in sql template binds.
  const yStartIso = yStart.toISOString();
  const todayStartIso = todayStart.toISOString();
  const todayEndIso = todayEnd.toISOString();
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = weekEnd.toISOString();

  const [agg] = await db
    .select({
      todayAwaiting: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('drafted', 'ready_for_review', 'approved')
        )
      `.mapWith(Number),
      todayShipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.completedAt} >= ${todayStartIso}
            and ${planItems.completedAt} < ${todayEndIso}
        )
      `.mapWith(Number),
      todaySkipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'skipped'
            and ${planItems.completedAt} >= ${todayStartIso}
            and ${planItems.completedAt} < ${todayEndIso}
        )
      `.mapWith(Number),
      yesterdayShipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.completedAt} >= ${yStartIso}
            and ${planItems.completedAt} < ${todayStartIso}
        )
      `.mapWith(Number),
      yesterdaySkipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'skipped'
            and ${planItems.completedAt} >= ${yStartIso}
            and ${planItems.completedAt} < ${todayStartIso}
        )
      `.mapWith(Number),
      weekQueued: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('planned', 'drafted', 'ready_for_review', 'approved')
            and ${planItems.scheduledAt} >= ${weekStartIso}
            and ${planItems.scheduledAt} < ${weekEndIso}
        )
      `.mapWith(Number),
      weekShipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.scheduledAt} >= ${weekStartIso}
            and ${planItems.scheduledAt} < ${weekEndIso}
        )
      `.mapWith(Number),
    })
    .from(planItems)
    .where(eq(planItems.userId, userId));

  const [productRow] = await db
    .select({ onboardingCompletedAt: products.onboardingCompletedAt })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  const isDay1 =
    productRow?.onboardingCompletedAt
      ? Date.now() - productRow.onboardingCompletedAt.getTime() < DAY_MS
      : false;

  const body: BriefingSummary = {
    today: {
      awaiting: agg?.todayAwaiting ?? 0,
      shipped: agg?.todayShipped ?? 0,
      skipped: agg?.todaySkipped ?? 0,
    },
    yesterday: {
      shipped: agg?.yesterdayShipped ?? 0,
      skipped: agg?.yesterdaySkipped ?? 0,
    },
    thisWeek: {
      totalQueued: agg?.weekQueued ?? 0,
      totalShipped: agg?.weekShipped ?? 0,
    },
    isDay1,
    nextDiscoveryAt: null,
  };

  return NextResponse.json(body);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm test src/app/api/briefing/__tests__/summary-route.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/briefing
git commit -m "feat(api): add /api/briefing/summary aggregate endpoint"
```

---

## Task 2: `BriefingHeader` component (TDD)

**Files:**
- Create: `src/app/(app)/briefing/_components/briefing-header.tsx`
- Create: `src/app/(app)/briefing/_components/__tests__/briefing-header.test.tsx`

Pure render given a `BriefingSummary | null` prop. Three states: steady, day-1, all-clear.

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/briefing/_components/__tests__/briefing-header.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { BriefingHeader } from '../briefing-header';
import type { BriefingSummary } from '@/app/api/briefing/summary/route';

const STEADY: BriefingSummary = {
  today: { awaiting: 1, shipped: 1, skipped: 0 },
  yesterday: { shipped: 2, skipped: 1 },
  thisWeek: { totalQueued: 6, totalShipped: 1 },
  isDay1: false,
  nextDiscoveryAt: null,
};

describe('<BriefingHeader>', () => {
  afterEach(cleanup);

  it('renders three steady-state lines', () => {
    render(<BriefingHeader summary={STEADY} />);
    expect(screen.getByText(/1 awaiting/)).toBeTruthy();
    expect(screen.getByText(/1 shipped/)).toBeTruthy();
    expect(screen.getByText(/6 more queued/)).toBeTruthy();
    expect(screen.getByText(/Yesterday/)).toBeTruthy();
  });

  it('renders day-1 hero copy when isDay1 is true', () => {
    render(<BriefingHeader summary={{ ...STEADY, isDay1: true }} />);
    expect(screen.getByText(/Day 1/)).toBeTruthy();
    expect(screen.getByText(/plan locked/)).toBeTruthy();
  });

  it('renders all-clear copy when caught up + at least one shipped today', () => {
    const caughtUp: BriefingSummary = {
      today: { awaiting: 0, shipped: 1, skipped: 0 },
      yesterday: { shipped: 0, skipped: 0 },
      thisWeek: { totalQueued: 0, totalShipped: 1 },
      isDay1: false,
      nextDiscoveryAt: null,
    };
    render(<BriefingHeader summary={caughtUp} />);
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  it('collapses to a single neutral line when summary is null', () => {
    render(<BriefingHeader summary={null} />);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.queryByText(/awaiting/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm test src/app/\(app\)/briefing/_components/__tests__/briefing-header.test.tsx
```

Expected: cannot find module `../briefing-header`.

- [ ] **Step 3: Implement the component**

Create `src/app/(app)/briefing/_components/briefing-header.tsx`:

```tsx
'use client';

import type { CSSProperties } from 'react';
import type { BriefingSummary } from '@/app/api/briefing/summary/route';

export interface BriefingHeaderProps {
  summary: BriefingSummary | null;
}

const wrapStyle: CSSProperties = {
  padding: '20px clamp(16px, 3vw, 32px) 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const titleStyle: CSSProperties = {
  fontSize: 'var(--sf-text-xl, 22px)',
  fontWeight: 600,
  letterSpacing: '-0.32px',
  margin: 0,
  color: 'var(--sf-fg-1)',
};

const subStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--sf-fg-2)',
};

export function BriefingHeader({ summary }: BriefingHeaderProps) {
  if (!summary) {
    return (
      <header style={wrapStyle}>
        <h1 style={titleStyle}>Today</h1>
      </header>
    );
  }

  if (summary.isDay1) {
    return (
      <header style={wrapStyle}>
        <h1 style={titleStyle}>Day 1 · plan locked</h1>
        <p style={subStyle}>
          Your team committed to {summary.thisWeek.totalQueued} item
          {summary.thisWeek.totalQueued === 1 ? '' : 's'} this week.
        </p>
      </header>
    );
  }

  const allClear =
    summary.today.awaiting === 0 &&
    summary.thisWeek.totalQueued === 0 &&
    summary.today.shipped >= 1;

  if (allClear) {
    return (
      <header style={wrapStyle}>
        <h1 style={titleStyle}>
          All clear · {summary.today.shipped} shipped today
        </h1>
        <p style={subStyle}>Discovery runs every few hours.</p>
      </header>
    );
  }

  const todayParts: string[] = [
    `${summary.today.awaiting} awaiting`,
    `${summary.today.shipped} shipped`,
  ];
  if (summary.today.skipped > 0) {
    todayParts.push(`${summary.today.skipped} skipped`);
  }
  const ySkipped =
    summary.yesterday.skipped > 0
      ? `, skipped ${summary.yesterday.skipped}`
      : '';
  return (
    <header style={wrapStyle}>
      <h1 style={titleStyle}>Today · {todayParts.join(' · ')}</h1>
      <p style={subStyle}>This week · {summary.thisWeek.totalQueued} more queued</p>
      <p style={subStyle}>
        Yesterday · shipped {summary.yesterday.shipped}
        {ySkipped}
      </p>
    </header>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm test src/app/\(app\)/briefing/_components/__tests__/briefing-header.test.tsx
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/briefing
git commit -m "feat(briefing): add BriefingHeader component (steady / day-1 / all-clear)"
```

---

## Task 3: `tab-nav` component (TDD)

**Files:**
- Create: `src/app/(app)/briefing/_components/tab-nav.tsx`
- Create: `src/app/(app)/briefing/_components/__tests__/tab-nav.test.tsx`

Two tabs: Today (`/briefing`) and Plan (`/briefing/plan`). Active tab matches the current pathname; clicking a tab pushes the corresponding URL via `next/link` (preserves `?weekStart` on the Plan side when set).

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/briefing/_components/__tests__/tab-nav.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

let pathname = '/briefing';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { TabNav } from '../tab-nav';

describe('<TabNav>', () => {
  afterEach(cleanup);

  it('marks Today active when pathname is /briefing', () => {
    pathname = '/briefing';
    render(<TabNav />);
    const todayLink = screen.getByRole('link', { name: 'Today' });
    expect(todayLink.getAttribute('aria-current')).toBe('page');
    const planLink = screen.getByRole('link', { name: 'Plan' });
    expect(planLink.getAttribute('aria-current')).toBeNull();
  });

  it('marks Plan active when pathname starts with /briefing/plan', () => {
    pathname = '/briefing/plan';
    render(<TabNav />);
    const planLink = screen.getByRole('link', { name: 'Plan' });
    expect(planLink.getAttribute('aria-current')).toBe('page');
  });

  it('Today link points to /briefing, Plan link points to /briefing/plan', () => {
    pathname = '/briefing';
    render(<TabNav />);
    expect(
      screen.getByRole('link', { name: 'Today' }).getAttribute('href'),
    ).toBe('/briefing');
    expect(
      screen.getByRole('link', { name: 'Plan' }).getAttribute('href'),
    ).toBe('/briefing/plan');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm test src/app/\(app\)/briefing/_components/__tests__/tab-nav.test.tsx
```

Expected: cannot find module `../tab-nav`.

- [ ] **Step 3: Implement the component**

Create `src/app/(app)/briefing/_components/tab-nav.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';

const TABS: ReadonlyArray<{ label: string; href: string; matchPrefix: string }> = [
  { label: 'Today', href: '/briefing', matchPrefix: '/briefing' },
  { label: 'Plan', href: '/briefing/plan', matchPrefix: '/briefing/plan' },
];

const navStyle: CSSProperties = {
  display: 'flex',
  gap: 24,
  padding: '0 clamp(16px, 3vw, 32px)',
  borderBottom: '1px solid var(--sf-border-1, rgba(0,0,0,0.08))',
};

const linkBase: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--sf-fg-3)',
  textDecoration: 'none',
  padding: '10px 0',
  borderBottom: '2px solid transparent',
  transition: 'color 120ms, border-color 120ms',
};

const linkActive: CSSProperties = {
  ...linkBase,
  color: 'var(--sf-fg-1)',
  borderBottomColor: 'var(--sf-fg-1)',
};

export function TabNav() {
  const pathname = usePathname() ?? '/briefing';
  // Plan is the longer prefix and must be checked first.
  const ordered = [...TABS].sort(
    (a, b) => b.matchPrefix.length - a.matchPrefix.length,
  );
  const active = ordered.find((t) => pathname.startsWith(t.matchPrefix));

  return (
    <nav style={navStyle} aria-label="Briefing tabs">
      {TABS.map((t) => {
        const isActive = active?.href === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            style={isActive ? linkActive : linkBase}
            aria-current={isActive ? 'page' : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm test src/app/\(app\)/briefing/_components/__tests__/tab-nav.test.tsx
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/briefing/_components
git commit -m "feat(briefing): add TabNav (Today / Plan) with pathname-driven active state"
```

---

## Task 4: Extract `<TodayBody>` from `today-content.tsx`

**Files:**
- Modify: `src/app/(app)/today/today-content.tsx`

`today-content.tsx` currently owns HeaderBar, WelcomeRibbon, TacticalProgressCard, SourceFilterRail, and the body sections. Extract a body-only `<TodayBody>` that the new Briefing route can render directly. Keep `<TodayContent>` as a thin wrapper that adds HeaderBar + WelcomeRibbon for `/today` (which still exists during the migration window).

`<TodayBody>` owns: TacticalProgressCard (in-flight gate is unchanged), SourceFilterRail, the Replies + Scheduled Posts sections, ShortcutsHelp dialog, keyboard shortcuts, and the `useToday()` hook. It does **not** own HeaderBar, MetaLine, or the Welcome ribbon.

- [ ] **Step 1: Read and confirm the current structure**

```bash
sed -n '320,475p' src/app/\(app\)/today/today-content.tsx
```

You should see HeaderBar at the top of the returned JSX, then `welcomeRibbon`, then `<TacticalProgressCard />`, then SourceFilterRail and the two `<Section>` blocks.

- [ ] **Step 2: Refactor — split the inner component**

Edit `src/app/(app)/today/today-content.tsx`:

1. Add a new export `TodayBody` that renders only the body (TacticalProgressCard, SourceFilterRail, Replies section, Scheduled posts section, CompletionState, ShortcutsHelp). Move all the existing hooks and handlers (`useToday`, `useToast`, `useRouter`, `useKeyboardShortcuts`, the `approve`/`skip`/etc. callbacks, the `replies`/`posts`/`filteredReplies` memo, `displaySources`, `activeIndex`, `editingId`, `helpOpen`, `sourceFilterId`) into `TodayBody`.
2. Keep `TodayContentInner` as the wrapper that renders `<HeaderBar>`, `welcomeRibbon`, then `<TodayBody />`. Pass `onboardingCompletedAt`, `initialLastScanAt` into `TodayContentInner` as today; `TodayBody` takes no props.

The replacement returned JSX inside `TodayContentInner` becomes:

```tsx
return (
  <>
    <HeaderBar title="Today" meta={metaLine} />
    {welcomeRibbon}
    <TodayBody />
  </>
);
```

…and the body is:

```tsx
export function TodayBody() {
  const {
    items,
    replySlots,
    stats,
    isLoading,
    approve: rawApprove,
    postNow: rawPostNow,
    skip: rawSkip,
    edit: rawEdit,
    reschedule: rawReschedule,
  } = useToday();
  // …all the local state, callbacks, memos that are CURRENTLY inside
  // TodayContentInner move into TodayBody verbatim, except for:
  //   - the `metaLine` const (stays in TodayContentInner)
  //   - the early `if (isLoading) return null` (move INTO TodayBody)
  //   - the HeaderBar + welcomeRibbon JSX (stays in TodayContentInner)
  // …and the returned JSX is the existing block from
  // `<TacticalProgressCard />` through `<ShortcutsHelp ... />`.
}
```

For `MetaLine` data that depended on `lastScanAt`: TodayContentInner already had `const lastScanAt = initialLastScanAt;`. Keep that there for `/today`'s HeaderBar — `TodayBody` does not need it.

- [ ] **Step 3: Type-check + run existing today tests (none for today-content directly, but the route test still hits route.ts)**

```bash
pnpm tsc --noEmit
pnpm test src/app/api/today
```

Expected: tsc green; today-route tests still pass.

- [ ] **Step 4: Smoke /today in the browser**

```bash
pnpm dev
```

Visit `http://localhost:3000/today` (signed in). The page should render exactly as before — HeaderBar at top, welcome ribbon (within 24h of onboarding), TacticalProgressCard (when in-flight), source filter rail, replies, scheduled posts. Nothing visual should change yet.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/today/today-content.tsx
git commit -m "refactor(today): extract <TodayBody> so /briefing can render it without the HeaderBar"
```

---

## Task 5: New `briefing/layout.tsx` shell

**Files:**
- Create: `src/app/(app)/briefing/layout.tsx`

Renders the BriefingHeader (SWR-fetched) above the TabNav, then `{children}`. Server-side initial paint via `auth + initial summary fetch`.

- [ ] **Step 1: Implement the layout**

Create `src/app/(app)/briefing/layout.tsx`:

```tsx
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { BriefingShell } from './_components/briefing-shell';

export default async function BriefingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) redirect('/onboarding');

  return <BriefingShell>{children}</BriefingShell>;
}
```

- [ ] **Step 2: Implement the client shell**

Create `src/app/(app)/briefing/_components/briefing-shell.tsx`:

```tsx
'use client';

import type { ReactNode } from 'react';
import useSWR from 'swr';
import type { BriefingSummary } from '@/app/api/briefing/summary/route';
import { BriefingHeader } from './briefing-header';
import { TabNav } from './tab-nav';

const fetcher = async (url: string): Promise<BriefingSummary | null> => {
  const r = await fetch(url);
  if (!r.ok) return null;
  return (await r.json()) as BriefingSummary;
};

export function BriefingShell({ children }: { children: ReactNode }) {
  const { data } = useSWR<BriefingSummary | null>(
    '/api/briefing/summary',
    fetcher,
    { refreshInterval: 60_000 },
  );
  return (
    <>
      <BriefingHeader summary={data ?? null} />
      <TabNav />
      {children}
    </>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/briefing
git commit -m "feat(briefing): add layout shell — header + tab nav with SWR summary"
```

---

## Task 6: `briefing/page.tsx` (Today route)

**Files:**
- Create: `src/app/(app)/briefing/page.tsx`
- Create: `src/app/(app)/briefing/_components/today-tab.tsx`

The Today tab renders `<TodayBody>` (extracted in Task 4). The page also seeds `onboardingCompletedAt` for any subordinate components that still use it (none today, but kept for parity with `/today`).

- [ ] **Step 1: Implement the today-tab wrapper**

Create `src/app/(app)/briefing/_components/today-tab.tsx`:

```tsx
'use client';

import { TodayBody } from '@/app/(app)/today/today-content';

/**
 * Briefing → Today tab. Re-uses the extracted <TodayBody> from the
 * legacy /today route so both surfaces share one implementation
 * during the migration window.
 */
export function TodayTab() {
  return <TodayBody />;
}
```

- [ ] **Step 2: Implement the page**

Create `src/app/(app)/briefing/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { TodayTab } from './_components/today-tab';

export const metadata: Metadata = { title: 'Briefing — Today' };
// Layout already runs the auth + onboarding gate. Force dynamic so
// SWR sees fresh data on every navigation.
export const dynamic = 'force-dynamic';

export default function BriefingTodayPage() {
  return <TodayTab />;
}
```

- [ ] **Step 3: Type-check + smoke /briefing in the browser**

```bash
pnpm tsc --noEmit
pnpm dev
```

Visit `http://localhost:3000/briefing`. Expect: BriefingHeader at top, "Today / Plan" tabs with Today active, then the same body you saw on `/today`.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/briefing
git commit -m "feat(briefing): add Today tab route + page"
```

---

## Task 7: `briefing/plan/page.tsx` (Plan route)

**Files:**
- Create: `src/app/(app)/briefing/plan/page.tsx`
- Create: `src/app/(app)/briefing/_components/plan-tab.tsx`

The Plan tab renders the existing `<CalendarContent />`.

- [ ] **Step 1: Implement the plan-tab wrapper**

Create `src/app/(app)/briefing/_components/plan-tab.tsx`:

```tsx
'use client';

import { CalendarContent } from '@/app/(app)/calendar/calendar-content';

export function PlanTab() {
  return <CalendarContent />;
}
```

- [ ] **Step 2: Implement the page**

Create `src/app/(app)/briefing/plan/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { PlanTab } from '../_components/plan-tab';

export const metadata: Metadata = { title: 'Briefing — Plan' };
export const dynamic = 'force-dynamic';

export default function BriefingPlanPage() {
  return <PlanTab />;
}
```

- [ ] **Step 3: Type-check + smoke /briefing/plan in the browser**

```bash
pnpm tsc --noEmit
pnpm dev
```

Visit `http://localhost:3000/briefing/plan`. Expect: BriefingHeader, tabs with Plan active, then the existing calendar week grid.

Visit `http://localhost:3000/briefing/plan?weekStart=2026-05-04`. Expect: navigates to that week.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/briefing
git commit -m "feat(briefing): add Plan tab route — embeds existing CalendarContent"
```

---

## Task 8: Per-card byline on `<PostCard>`

**Files:**
- Modify: `src/app/(app)/today/_components/post-card.tsx`

Add a one-liner under the card title: `Drafted by your writer · scheduled <local time>`.

- [ ] **Step 1: Read the current PostCard structure**

```bash
sed -n '1,60p' src/app/\(app\)/today/_components/post-card.tsx
```

Note where the title renders. The `item.scheduledFor` field carries the ISO timestamp.

- [ ] **Step 2: Add the byline under the title**

Find the JSX block that renders the post title in `post-card.tsx`. Immediately under it, add:

```tsx
<div
  className="sf-mono"
  style={{
    marginTop: 2,
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
    letterSpacing: 'var(--sf-track-mono)',
  }}
>
  Drafted by your writer{item.scheduledFor ? ` · scheduled ${formatLocalTime(item.scheduledFor)}` : ''}
</div>
```

…and add the helper at the bottom of the file (above the default-export, if any):

```ts
function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
```

- [ ] **Step 3: Visual smoke**

```bash
pnpm dev
```

Visit `http://localhost:3000/briefing` (or `/today`) with at least one drafted post. Confirm the new byline renders under the title.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/today/_components/post-card.tsx
git commit -m "feat(today): add 'Drafted by your writer · scheduled …' byline to PostCard"
```

---

## Task 9: Per-card byline on `<ReplyCard>`

**Files:**
- Modify: `src/app/(app)/today/_components/reply-card.tsx`

Add a one-liner: `Your scout flagged this · r/<community> · score <X.Y>` (or a graceful subset when fields are absent).

- [ ] **Step 1: Read the current ReplyCard structure**

```bash
sed -n '1,80p' src/app/\(app\)/today/_components/reply-card.tsx
```

Note where the thread/title renders. Available fields: `item.community`, `item.platform`, `item.draftConfidence`.

- [ ] **Step 2: Add the byline near the top of the card body**

Insert directly under the card title block:

```tsx
<div
  className="sf-mono"
  style={{
    marginTop: 2,
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
    letterSpacing: 'var(--sf-track-mono)',
  }}
>
  Your scout flagged this
  {item.community ? ` · ${item.platform === 'reddit' ? 'r/' : ''}${item.community}` : ''}
  {typeof item.draftConfidence === 'number'
    ? ` · score ${item.draftConfidence.toFixed(1)}`
    : ''}
</div>
```

- [ ] **Step 3: Visual smoke**

```bash
pnpm dev
```

Confirm a drafted reply shows the byline.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/today/_components/reply-card.tsx
git commit -m "feat(today): add 'Your scout flagged this · …' byline to ReplyCard"
```

---

## Task 10: Replace TodayBody empty-state hero with one-liner

**Files:**
- Modify: `src/app/(app)/today/today-content.tsx`

Today the empty state inside the Replies section uses `<EmptyState>` with the title `'All caught up on replies.'` and a hint. With BriefingHeader carrying the celebration, the body should just have a thin one-liner.

- [ ] **Step 1: Replace the EmptyState block**

Find the JSX inside the `Replies` `<Section>` where `filteredReplies.length === 0` renders `<EmptyState ... />` (no source filter active). Replace **only** the unfiltered empty state — when a `sourceFilterId` is set, keep the existing "Nothing here / Clear filter" affordance.

Replacement:

```tsx
{filteredReplies.length === 0 ? (
  sourceFilterId ? (
    <EmptyState
      title="Nothing here"
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSourceFilterId(null)}
        >
          Clear filter
        </Button>
      }
    />
  ) : (
    <p
      className="sf-mono"
      style={{
        fontSize: 'var(--sf-text-xs)',
        color: 'var(--sf-fg-3)',
        padding: '8px 0',
        margin: 0,
      }}
    >
      Nothing on you right now. Next drafts ~10min before scheduled slots.
    </p>
  )
) : (
  /* existing list rendering — unchanged */
)}
```

- [ ] **Step 2: Type-check + smoke**

```bash
pnpm tsc --noEmit
pnpm dev
```

Visit `/briefing` with no pending replies. Confirm the new one-liner.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/today/today-content.tsx
git commit -m "feat(today): collapse Replies empty hero into one-liner — header carries the celebration"
```

---

## Task 11: Update in-app `/today` and `/calendar` references

**Files:**
- Modify: `src/components/layout/nav-items.ts`
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/app/(app)/error.tsx`
- Modify: `src/app/(app)/not-found.tsx`
- Modify: `src/app/not-found.tsx`
- Modify: `src/app/actions/auth.ts`
- Modify: `src/lib/oauth-return.ts`
- Modify: `src/components/marketing/hero-demo.tsx`
- Modify: `src/components/marketing/cta-section.tsx`
- Modify: `src/components/marketing/glass-nav.tsx`
- Modify: `src/app/(app)/team/_components/onboarding-banner.tsx`

Repoint every in-app link/redirect to the new path. Marketing pages move to `/briefing`. The `/calendar` nav entry collapses into the Briefing entry — there is now ONE nav item, "Briefing", that lands on `/briefing`.

- [ ] **Step 1: Update `nav-items.ts` — collapse Today + Calendar into Briefing**

Replace the two existing entries (`/today` and `/calendar`) with one Briefing entry:

```ts
export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  {
    href: '/briefing',
    label: 'Briefing',
    Icon: TodayIcon,
    // /today and /calendar are 301-redirected to /briefing; aliases keep
    // the topnav label correct during the redirect flash.
    aliases: [/^\/today/, /^\/calendar/, /^\/briefing/],
  },
  {
    href: '/team',
    label: 'My AI Team',
    Icon: ZapIcon,
    aliases: [/^\/automation/],
  },
  { href: '/product', label: 'My Product', Icon: ProductIcon },
  { href: '/growth', label: 'Growth', Icon: GrowthIcon },
  { href: '/settings', label: 'Settings', Icon: GearIcon },
];
```

(Drop the `CalendarIcon` import if no longer used; tsc will complain otherwise.)

- [ ] **Step 2: Update `sidebar.tsx`**

Find `href="/today"` (line ~172) and replace with `href="/briefing"`. The label, if hardcoded, becomes `Briefing`.

- [ ] **Step 3: Update error/404 fallback links**

In `src/app/(app)/error.tsx`, `src/app/not-found.tsx`, `src/app/(app)/not-found.tsx`: replace `href="/today"` and `window.location.href = '/today'` with `/briefing`.

- [ ] **Step 4: Update auth + OAuth redirects**

```ts
// src/app/actions/auth.ts
await signIn('github', { redirectTo: '/briefing' });

// src/lib/oauth-return.ts
export const DEFAULT_OAUTH_RETURN = '/briefing';
```

- [ ] **Step 5: Update marketing pages**

In `src/components/marketing/hero-demo.tsx`, `cta-section.tsx`, `glass-nav.tsx`: replace `'/today'` with `'/briefing'`.

- [ ] **Step 6: Update `onboarding-banner.tsx` copy**

Replace the existing `/today` mention. Suggested copy (preserves tone):

```tsx
…and draft replies — drafts land in <a href="/briefing">/briefing</a> for your approval.
```

- [ ] **Step 7: Search for any remaining hardcoded paths**

```bash
grep -rn "\"/today\"\|'/today'\|\"/calendar\"\|'/calendar'" src \
  --include="*.ts" --include="*.tsx" \
  | grep -v "__tests__\|\\.test\\." | grep -v "// .*"
```

Address each hit (excluding the `redirects` block we'll add in Task 12 and the legacy `/today` and `/calendar` route directories themselves, which stay until cleanup).

- [ ] **Step 8: Type-check + smoke**

```bash
pnpm tsc --noEmit
pnpm dev
```

Click around the sidebar — Briefing should be the only inbox/calendar entry; clicking it lands on `/briefing`. Marketing CTAs should point at `/briefing`.

- [ ] **Step 9: Commit**

```bash
git add src
git commit -m "refactor(routing): repoint in-app /today and /calendar references to /briefing"
```

---

## Task 12: Wire 301 redirects in `next.config.ts`

**Files:**
- Modify: `next.config.ts`

Permanent redirects so old bookmarks resolve. Preserve `?weekStart=` on the calendar redirect.

- [ ] **Step 1: Edit `next.config.ts`**

Inside `redirects()`, append two new entries:

```ts
async redirects() {
  return [
    {
      source: '/automation',
      destination: '/team',
      permanent: false,
    },
    {
      source: '/today',
      destination: '/briefing',
      permanent: true,
    },
    {
      source: '/calendar',
      destination: '/briefing/plan',
      permanent: true,
    },
  ];
},
```

Note: query strings are forwarded by Next's redirect handler by default unless overridden — so `?weekStart=2026-05-04` survives `/calendar → /briefing/plan` automatically.

- [ ] **Step 2: Restart dev server and verify redirects**

```bash
# Ctrl-C the existing dev server, then
pnpm dev
```

Visit:
- `http://localhost:3000/today` → should land on `/briefing`
- `http://localhost:3000/calendar` → `/briefing/plan`
- `http://localhost:3000/calendar?weekStart=2026-05-04` → `/briefing/plan?weekStart=2026-05-04`

- [ ] **Step 3: Commit**

```bash
git add next.config.ts
git commit -m "feat(routing): 301 /today → /briefing and /calendar → /briefing/plan"
```

---

## Task 13: Live-smoke spec for redirects + tab switching

**Files:**
- Create: `e2e/tests/briefing-tabs.live-smoke.ts`

Verifies the redirect chain and tab routing against a real running dev server with the founder's authenticated storageState.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/briefing-tabs.live-smoke.ts`:

```ts
/**
 * Briefing route + redirect smoke. Asserts:
 *   - /briefing renders with the BriefingHeader title and Today tab active
 *   - clicking Plan navigates to /briefing/plan and the calendar grid renders
 *   - direct visits to /today and /calendar 301-redirect into /briefing
 *   - ?weekStart on /calendar survives the redirect
 *
 * Uses the live-smoke project (auto-skipped without .auth/founder.json).
 */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const AUTH_PATH = '.auth/founder.json';
test.skip(
  !fs.existsSync(AUTH_PATH),
  `live-smoke needs .auth/founder.json — see e2e/README.md for capture instructions.`,
);

test('briefing tabs + legacy route redirects', async ({ page }) => {
  await page.goto('/briefing');
  await expect(page).toHaveURL(/\/briefing(\/)?$/);
  // Header renders with at least one of the steady/day-1 markers.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();

  // Today tab is active.
  const todayLink = page.getByRole('link', { name: 'Today' });
  await expect(todayLink).toHaveAttribute('aria-current', 'page');

  // Click Plan.
  await page.getByRole('link', { name: 'Plan' }).click();
  await expect(page).toHaveURL(/\/briefing\/plan/);
  const planLink = page.getByRole('link', { name: 'Plan' });
  await expect(planLink).toHaveAttribute('aria-current', 'page');

  // Calendar week grid renders something — minimum: a visible day label.
  // Loose assertion intentionally; existing /calendar visual tests cover layout.
  await expect(page.locator('body')).toContainText(/Mon|Tue|Wed|Thu|Fri/);

  // Legacy redirects.
  await page.goto('/today');
  await expect(page).toHaveURL(/\/briefing(\/)?$/);

  await page.goto('/calendar?weekStart=2026-05-04');
  await expect(page).toHaveURL(/\/briefing\/plan\?weekStart=2026-05-04/);
});
```

- [ ] **Step 2: Run the live-smoke spec against a running dev server**

```bash
# Terminal 1
pnpm dev

# Terminal 2
pnpm test:e2e:live -- e2e/tests/briefing-tabs.live-smoke.ts
```

Expected: spec passes (or auto-skips if `.auth/founder.json` is missing — which is acceptable for a non-CI environment).

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/briefing-tabs.live-smoke.ts
git commit -m "test(live-smoke): briefing tabs + /today and /calendar redirect chain"
```

---

## Task 14: Final type-check + build verification

**Files:** none

Project memory: `pnpm tsc --noEmit` is the build gate, not vitest. End the work green.

- [ ] **Step 1: Run all unit + integration tests**

```bash
pnpm test
```

Expected: all green. Note any failures and fix the underlying cause (do not skip / mute tests).

- [ ] **Step 2: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Production build**

```bash
pnpm build
```

Expected: green build. The `/today` and `/calendar` routes still exist as physical directories (kept for one release cycle per spec) — they simply never get hit because of the redirects. They should still type-check and build.

- [ ] **Step 4: Manual QA pass against the spec's checklist**

Run each of the three flows the spec calls out:

1. **Day-1 founder flow.** Sign in fresh → complete onboarding → land on `/briefing` → header reads `Day 1 · plan locked` with a non-zero "committed to N items this week" subline.
2. **Old-bookmark flow.** Visit `/today` → 301 to `/briefing`. Visit `/calendar?weekStart=2026-05-04` → 301 to `/briefing/plan?weekStart=2026-05-04`.
3. **Empty-Today + non-empty-Plan flow.** With a fresh kickoff (drafts scheduled later in the week), `/briefing` should show 0 awaiting cards but the header should read `… · 6 more queued` and the Plan tab should show populated days.

- [ ] **Step 5: Final commit (if anything was caught in QA)**

If the QA pass was clean, no commit needed. Otherwise fix and commit per the convention.

```bash
git status
```

---

## Self-review

**Spec coverage (cross-checked against `docs/superpowers/specs/2026-05-03-briefing-redesign-design.md`):**

| Spec section | Implementing tasks |
|---|---|
| §1 Architecture & routing | Tasks 5, 6, 7, 12 |
| §2 BriefingHeader | Tasks 1, 2 |
| §3 Today tab — byline + empty state | Tasks 4, 8, 9, 10 |
| §4 Plan tab | Task 7 |
| §5 Data flow & error handling | Tasks 1, 5 (SWR + auth gate) |
| §6 Testing | Tasks 1–3 (unit), 13 (live-smoke), 14 (build gate) |
| Old-route cleanup (post-release) | Out of scope per spec; tracked separately. |

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to Task N" in this plan. Every code step contains the actual content the engineer needs.

**Type consistency:**
- `BriefingSummary` is defined in `src/app/api/briefing/summary/route.ts` (Task 1) and consumed via re-import in `briefing-header.tsx` (Task 2), `briefing-shell.tsx` (Task 5), and the unit test in Task 2.
- `TodayBody` named export in `today-content.tsx` (Task 4) is consumed by `today-tab.tsx` in Task 6.
- `CalendarContent` (existing) is consumed by `plan-tab.tsx` in Task 7 — no rename.
- `TabNav` props: `()` (no props in Task 3); rendered with no props in Task 5. Consistent.

**Field-source honesty:** the per-card byline (Tasks 8, 9) derives `writer` and `scout` labels from the row kind / source — no phantom DB column. Aligned with the spec's self-reviewed §3 wording.

---

## Distribution & rollout

Standard merge-to-main + Vercel deploy. No feature flag — the redirects make migration atomic from the user's perspective.

Old `/today` and `/calendar` directories remain in the codebase for one full release cycle (~2 weeks). After analytics confirm zero traffic, a follow-up plan deletes:
- `src/app/(app)/today/`
- `src/app/(app)/calendar/`
- `src/components/today/today-welcome-ribbon.tsx` (if no other consumer)
- The `redirects()` entries for `/today` and `/calendar`

That cleanup is out of scope for this plan.
