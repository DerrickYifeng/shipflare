# Multi-Tenant Stability + Chat Frontend Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the team-chat experience under load by (A) refactoring the chat UI to borrow engine/'s sticky-tail + bottom-task-panel patterns, (B) installing a per-tenant fairness / LLM rate-limit safety net on the existing BullMQ stack, and (D) refactoring the team-lead orchestrator from "occupy worker slot until done" to "yield + re-enqueue on event" so a single user's fan-out can no longer monopolize the worker pool.

**Architecture:** Three independent phases, each independently ship-able and reversible:
- **Phase A** (frontend): Add a separate bottom subagent panel, virtualize the message list, and isolate streaming-partial state so token deltas don't re-render the full thread.
- **Phase B** (backend safety net): Bump Postgres pool, enable prompt caching everywhere, add a Redis-Lua per-tenant in-flight semaphore + hierarchical Anthropic token bucket, split the `agent-run` queue into priority lanes.
- **Phase D** (durable lead, originally numbered 3A): Add `checkpoint` + `waiting_for` columns to `agent_runs`, refactor the lead loop into a one-step state machine that persists and returns; teammate completion re-enqueues the parent.

Phases A and B can ship in parallel by different engineers. D depends on B's Lua bucket being live (so re-enqueue backpressure has somewhere to land).

> **Why no LLM-gateway phase:** The original draft included a Phase C that routed all LLM calls through self-hosted LiteLLM Proxy. Removed by user request after weighing tradeoffs. Phase B's Lua hierarchical token bucket already enforces per-tenant + global Anthropic rate limits, and shipflare doesn't currently need provider fallback, BYO-key, or multi-provider abstraction. The `src/core/api-client.ts` singleton remains the SSOT enforced by code review.

**Tech Stack:**
- Next.js 16 + React 19 (App Router) — frontend
- BullMQ 5.73 on Redis (ioredis 5.10) — workers
- Postgres 15 via `postgres` + Drizzle ORM 0.45
- Anthropic SDK 0.88, xAI HTTP
- Bun runtime for workers; Node for Next.js
- Vitest for unit/integration; Playwright 1.59 for E2E

**Conventions used throughout this plan:**
- All Lua scripts live in `src/lib/redis-scripts/` and are loaded via ioredis `defineCommand`.
- All new DB migrations go in `scripts/migrations/` (SQL files) and are applied via `bun run scripts/run-migrations.ts`.
- Run all tests with `bun run test path/to/test.ts -- -t "test name"`. Type-check with `bun run typecheck` (per memory: this is the build gate, not vitest).
- Per memory `feedback_playwright_real_browser_in_plans`: every phase ends with a real-browser smoke test that connects to the user's existing authenticated browser context.

---

## Phase A — Frontend Chat Refactor

**Why:** The current `src/app/(app)/team/_components/conversation.tsx` is 685 lines, receives streaming partials as React props (`partials`, `toolInputPartials`), and runs the full `groupByRun` + `stitchLeadMessages` reducer on every token delta. The existing `useAutoScroll` hook (149 lines, uses ResizeObserver + sticky flag — already correct, matches engine's `ScrollBox.isSticky()` pattern) does NOT need a rewrite. The fix is to (1) move streaming partials out of props into a ref-based context so they don't re-render the conversation, (2) pull in-flight subagents out of the interleaved stream into a separate sticky bottom panel (engine's `TaskListV2` pattern), and (3) virtualize the message list so long sessions render in O(viewport) not O(history).

**Outcome:** Conversation re-renders only on completed-message commits. Token streams update one node's text via a separate subscription. Long sessions stay fast. In-flight subagents are always visible in a pinned panel regardless of scroll position.

---

### Task A1: Extract streaming-partial state into a dedicated context

**Files:**
- Create: `src/app/(app)/team/_components/streaming-context.tsx`
- Create: `src/app/(app)/team/_components/__tests__/streaming-context.test.tsx`
- Modify: `src/app/(app)/team/_components/team-desk.tsx` (wrap conversation in provider)
- Modify: `src/app/(app)/team/_components/conversation.tsx` (drop `partials` / `toolInputPartials` props)

**Rationale:** Right now `team-desk.tsx` passes `partials: ReadonlyMap<string, PartialLeadMessage>` straight into `<Conversation>`. Every token append produces a new Map → Conversation re-renders → the entire `stitchLeadMessages` reducer runs. We want token deltas to mutate a ref behind a context, and only the LeafMessage component that owns that message-id subscribes.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/(app)/team/_components/__tests__/streaming-context.test.tsx
import { render, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  StreamingProvider,
  useStreamingPartial,
  useStreamingDispatch,
} from '../streaming-context';

describe('StreamingProvider', () => {
  it('only re-renders subscribers whose messageId changed', () => {
    let renderCountA = 0;
    let renderCountB = 0;

    function ProbeA() {
      useStreamingPartial('msg-a');
      renderCountA += 1;
      return null;
    }
    function ProbeB() {
      useStreamingPartial('msg-b');
      renderCountB += 1;
      return null;
    }

    let dispatch!: ReturnType<typeof useStreamingDispatch>;
    function Capture() {
      dispatch = useStreamingDispatch();
      return null;
    }

    render(
      <StreamingProvider>
        <Capture />
        <ProbeA />
        <ProbeB />
      </StreamingProvider>,
    );

    const before = { a: renderCountA, b: renderCountB };
    act(() => {
      dispatch.appendDelta('msg-a', 'hello');
    });
    expect(renderCountA).toBeGreaterThan(before.a);
    expect(renderCountB).toBe(before.b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test src/app/\(app\)/team/_components/__tests__/streaming-context.test.tsx
```

Expected: FAIL — module `../streaming-context` not found.

- [ ] **Step 3: Implement the context**

```tsx
// src/app/(app)/team/_components/streaming-context.tsx
'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

interface Partial {
  text: string;
  updatedAt: number;
}

class StreamingStore {
  private partials = new Map<string, Partial>();
  private toolInputs = new Map<string, string>();
  private subscribers = new Map<string, Set<() => void>>();

  subscribe(messageId: string, cb: () => void): () => void {
    let set = this.subscribers.get(messageId);
    if (!set) {
      set = new Set();
      this.subscribers.set(messageId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.subscribers.delete(messageId);
    };
  }

  getPartial(messageId: string): Partial | undefined {
    return this.partials.get(messageId);
  }

  getToolInput(toolUseId: string): string | undefined {
    return this.toolInputs.get(toolUseId);
  }

  appendDelta(messageId: string, delta: string): void {
    const prev = this.partials.get(messageId);
    this.partials.set(messageId, {
      text: (prev?.text ?? '') + delta,
      updatedAt: Date.now(),
    });
    this.subscribers.get(messageId)?.forEach((cb) => cb());
  }

  appendToolInput(toolUseId: string, delta: string): void {
    this.toolInputs.set(toolUseId, (this.toolInputs.get(toolUseId) ?? '') + delta);
    this.subscribers.get(toolUseId)?.forEach((cb) => cb());
  }

  finalize(messageId: string): void {
    this.partials.delete(messageId);
    this.subscribers.get(messageId)?.forEach((cb) => cb());
  }
}

const Ctx = createContext<StreamingStore | null>(null);

export function StreamingProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new StreamingStore(), []);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStreamingPartial(messageId: string): Partial | undefined {
  const store = useContext(Ctx);
  if (!store) throw new Error('useStreamingPartial outside StreamingProvider');
  return useSyncExternalStore(
    (cb) => store.subscribe(messageId, cb),
    () => store.getPartial(messageId),
    () => undefined,
  );
}

export function useStreamingToolInput(toolUseId: string): string | undefined {
  const store = useContext(Ctx);
  if (!store) throw new Error('useStreamingToolInput outside StreamingProvider');
  return useSyncExternalStore(
    (cb) => store.subscribe(toolUseId, cb),
    () => store.getToolInput(toolUseId),
    () => undefined,
  );
}

export function useStreamingDispatch(): Pick<
  StreamingStore,
  'appendDelta' | 'appendToolInput' | 'finalize'
> {
  const store = useContext(Ctx);
  if (!store) throw new Error('useStreamingDispatch outside StreamingProvider');
  return store;
}
```

- [ ] **Step 4: Wire team-desk to dispatch into context**

Read `src/app/(app)/team/_components/team-desk.tsx` — find where `partials` is consumed from `useTeamEvents`. Replace with: feed every `agent_text_delta` event into `dispatch.appendDelta(messageId, delta)`, every `tool_input_delta` into `dispatch.appendToolInput`, and call `dispatch.finalize` on `agent_text` / `tool_use` terminal events. Drop the `partials` and `toolInputPartials` props passed to `<Conversation>`.

- [ ] **Step 5: Update LeadMessage to read partial via hook**

In `src/app/(app)/team/_components/lead-message.tsx`, replace the prop-based partial with `const partial = useStreamingPartial(props.messageId)`. Same in `delegation-card.tsx` for tool inputs via `useStreamingToolInput`.

- [ ] **Step 6: Run test to verify it passes**

```bash
bun run test src/app/\(app\)/team/_components/__tests__/streaming-context.test.tsx
bun run typecheck
```

Expected: test PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/team/_components/streaming-context.tsx \
        src/app/\(app\)/team/_components/__tests__/streaming-context.test.tsx \
        src/app/\(app\)/team/_components/team-desk.tsx \
        src/app/\(app\)/team/_components/conversation.tsx \
        src/app/\(app\)/team/_components/lead-message.tsx \
        src/app/\(app\)/team/_components/delegation-card.tsx
git commit -m "refactor(team-chat): move streaming partials into useSyncExternalStore context"
```

---

### Task A2: Add a sticky bottom subagent panel

**Files:**
- Create: `src/app/(app)/team/_components/active-subagents-rail.tsx`
- Create: `src/app/(app)/team/_components/__tests__/active-subagents-rail.test.tsx`
- Modify: `src/app/(app)/team/_components/team-desk.tsx` (slot the rail below the scroll container)
- Modify: `src/app/(app)/team/_components/conversation.tsx` (stop interleaving in-flight subagents)

**Rationale:** Today an in-flight subagent appears inside the message stream — as the stream grows it can scroll out of view, which is the engine pattern's exact failure mode. Engine puts in-flight tasks in a separate flexbox-fixed bottom panel (`TaskListV2`). We do the same: a horizontal scrollable rail pinned above the composer, showing all `agent_runs` with `status IN ('queued','running','sleeping')` for the current team. Completed teammates fade out of the rail after 30s. The message stream stops trying to render in-flight subagents inline (it keeps showing completed Task tool-use blocks as cards).

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/(app)/team/_components/__tests__/active-subagents-rail.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ActiveSubagentsRail } from '../active-subagents-rail';

describe('ActiveSubagentsRail', () => {
  it('shows running and sleeping subagents, hides completed beyond TTL', () => {
    const now = Date.now();
    render(
      <ActiveSubagentsRail
        now={now}
        subagents={[
          { id: 'a', name: 'x-replies', status: 'running', lastActiveAt: now },
          { id: 'b', name: 'reddit-research', status: 'sleeping', lastActiveAt: now - 1000 },
          { id: 'c', name: 'post-batch', status: 'completed', lastActiveAt: now - 31_000 },
          { id: 'd', name: 'x-discovery', status: 'completed', lastActiveAt: now - 5_000 },
        ]}
      />,
    );
    expect(screen.getByText('x-replies')).toBeInTheDocument();
    expect(screen.getByText('reddit-research')).toBeInTheDocument();
    expect(screen.getByText('x-discovery')).toBeInTheDocument(); // within 30s TTL
    expect(screen.queryByText('post-batch')).toBeNull(); // > 30s after completion
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test src/app/\(app\)/team/_components/__tests__/active-subagents-rail.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rail**

```tsx
// src/app/(app)/team/_components/active-subagents-rail.tsx
'use client';

const RECENT_COMPLETED_TTL_MS = 30_000;

export interface RailSubagent {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'sleeping' | 'completed' | 'failed' | 'killed';
  lastActiveAt: number;
}

export interface ActiveSubagentsRailProps {
  subagents: readonly RailSubagent[];
  /** Override Date.now() for tests. */
  now?: number;
  onSelect?: (id: string) => void;
}

export function ActiveSubagentsRail({
  subagents,
  now = Date.now(),
  onSelect,
}: ActiveSubagentsRailProps) {
  const visible = subagents
    .filter((s) => {
      if (s.status === 'queued' || s.status === 'running' || s.status === 'sleeping') return true;
      return now - s.lastActiveAt < RECENT_COMPLETED_TTL_MS;
    })
    .sort((a, b) => {
      const aPri = priorityForStatus(a.status);
      const bPri = priorityForStatus(b.status);
      if (aPri !== bPri) return aPri - bPri;
      return b.lastActiveAt - a.lastActiveAt;
    });

  if (visible.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Active teammates"
      className="border-t border-zinc-200 bg-zinc-50/80 backdrop-blur px-4 py-2"
    >
      <div className="flex gap-2 overflow-x-auto">
        {visible.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect?.(s.id)}
            className="shrink-0 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs"
            data-status={s.status}
          >
            <span className="font-medium">{s.name}</span>
            <span className="ml-2 text-zinc-500">{s.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function priorityForStatus(s: RailSubagent['status']): number {
  switch (s) {
    case 'running': return 0;
    case 'queued': return 1;
    case 'sleeping': return 2;
    default: return 3;
  }
}
```

- [ ] **Step 4: Slot the rail into TeamDesk and hide in-flight cards from conversation**

In `team-desk.tsx`, render the rail between the scrollable conversation container and the sticky composer. Source the data from the existing `agent_runs` SWR query (filter to current team). In `conversation.tsx`, the `DelegationCard` keeps rendering completed Task tool_use blocks (history). Add a prop `activeSubagentIds: Set<string>` and have DelegationCard render a thin "see in rail" hint instead of the full pulsing card when its agent is in the active set — so we don't show the same teammate twice.

- [ ] **Step 5: Run test + manual check**

```bash
bun run test src/app/\(app\)/team/_components/__tests__/active-subagents-rail.test.tsx
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/team/_components/active-subagents-rail.tsx \
        src/app/\(app\)/team/_components/__tests__/active-subagents-rail.test.tsx \
        src/app/\(app\)/team/_components/team-desk.tsx \
        src/app/\(app\)/team/_components/conversation.tsx \
        src/app/\(app\)/team/_components/delegation-card.tsx
git commit -m "feat(team-chat): pin in-flight teammates to bottom rail (engine TaskListV2 pattern)"
```

---

### Task A3: Virtualize the message list

**Files:**
- Modify: `package.json` (add `@tanstack/react-virtual`)
- Create: `src/app/(app)/team/_components/virtual-conversation.tsx`
- Modify: `src/app/(app)/team/_components/conversation.tsx` (delegate render to VirtualConversation when message count > 50)
- Create: `src/app/(app)/team/_components/__tests__/virtual-conversation.test.tsx`

**Rationale:** Long discovery sessions accumulate hundreds of nodes. Each one re-renders on every conversation re-render today. `@tanstack/react-virtual` measures items via ResizeObserver (matches engine's Yoga measurement spirit), supports dynamic heights, and integrates cleanly with the existing scroll container — `useAutoScroll` already holds the container ref. Threshold of 50 keeps small sessions on the simple render path (no virtualization tax).

- [ ] **Step 1: Add dependency**

```bash
bun add @tanstack/react-virtual@^3.13.0
```

- [ ] **Step 2: Write the failing test**

```tsx
// src/app/(app)/team/_components/__tests__/virtual-conversation.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { VirtualConversation } from '../virtual-conversation';

describe('VirtualConversation', () => {
  it('renders only visible items', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      kind: 'user' as const,
      id: `u${i}`,
      text: `msg ${i}`,
    }));
    const { container } = render(
      <div style={{ height: 600 }}>
        <VirtualConversation nodes={nodes} renderNode={(n) => <div data-id={n.id}>{n.text}</div>} />
      </div>,
    );
    const rendered = container.querySelectorAll('[data-id]');
    // We don't pin an exact count (depends on measured heights), but it should
    // be a small fraction of the full 500.
    expect(rendered.length).toBeLessThan(60);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun run test src/app/\(app\)/team/_components/__tests__/virtual-conversation.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement VirtualConversation**

```tsx
// src/app/(app)/team/_components/virtual-conversation.tsx
'use client';

import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualNode {
  id: string;
}

export interface VirtualConversationProps<N extends VirtualNode> {
  nodes: readonly N[];
  renderNode: (node: N) => ReactNode;
  estimateSize?: number;
  overscan?: number;
}

export function VirtualConversation<N extends VirtualNode>({
  nodes,
  renderNode,
  estimateSize = 120,
  overscan = 8,
}: VirtualConversationProps<N>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const node = nodes[vi.index]!;
          return (
            <div
              key={node.id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderNode(node)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Conditionally swap in conversation.tsx**

```tsx
// In Conversation's render:
const VIRTUAL_THRESHOLD = 50;
if (sessionGroups.flatMap((g) => g.nodes).length > VIRTUAL_THRESHOLD) {
  // flatten into a single id-keyed list, pass to VirtualConversation
  return <VirtualConversation nodes={flatNodes} renderNode={renderConversationNode} />;
}
// else existing render path
```

Important: the existing `useAutoScroll` watches the OLD scroll container. When VirtualConversation owns the scroll, switch `containerRef` to point at VirtualConversation's parent. Add a forwardRef to expose it.

- [ ] **Step 6: Run test + typecheck**

```bash
bun run test src/app/\(app\)/team/_components/__tests__/virtual-conversation.test.tsx
bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/app/\(app\)/team/_components/virtual-conversation.tsx \
        src/app/\(app\)/team/_components/__tests__/virtual-conversation.test.tsx \
        src/app/\(app\)/team/_components/conversation.tsx
git commit -m "perf(team-chat): virtualize message list past 50 nodes"
```

---

### Task A4: Real-browser smoke test for chat refactor

**Files:**
- Create: `e2e/tests/team-chat-refactor.spec.ts`

**Rationale:** Memory rule `feedback_playwright_real_browser_in_plans` — every plan ships a real-browser smoke. The user has GitHub authenticated locally; Playwright can connect to the running dev server with the persistent profile.

- [ ] **Step 1: Write the test**

```ts
// e2e/tests/team-chat-refactor.spec.ts
import { test, expect } from '@playwright/test';

test('team chat: streaming partial does not unstick scroll', async ({ page }) => {
  await page.goto('http://localhost:3000/team');
  // Wait for the conversation container to mount.
  const scroller = page.getByRole('region', { name: /conversation/i }).first();
  await expect(scroller).toBeVisible();

  // Send a message that triggers a long lead response.
  await page.getByPlaceholder(/Message your team/i).fill('Draft a 5-paragraph weekly retro');
  await page.keyboard.press('Enter');

  // Scroll position should stay pinned to bottom as deltas arrive.
  await page.waitForTimeout(2000); // let some deltas land
  const isPinned = await scroller.evaluate((el) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop < 100;
  });
  expect(isPinned).toBe(true);
});

test('team chat: in-flight teammate appears in bottom rail', async ({ page }) => {
  await page.goto('http://localhost:3000/team');
  await page.getByPlaceholder(/Message your team/i).fill('Find me Reddit threads to reply to');
  await page.keyboard.press('Enter');

  const rail = page.getByRole('region', { name: /active teammates/i });
  await expect(rail).toBeVisible({ timeout: 30_000 });
  // Should show at least one teammate while reddit-replies is running.
  await expect(rail.locator('button')).toHaveCount(/^\d+$/, { timeout: 10_000 });
});
```

- [ ] **Step 2: Run with the running dev server**

```bash
# In one terminal:
bun run dev
# In another:
bun run test:e2e:live -- --grep "team chat:"
```

Expected: both tests PASS against the live local app.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/team-chat-refactor.spec.ts
git commit -m "test(e2e): team chat sticky scroll + bottom rail smoke"
```

---

## Phase B — Multi-Tenant Safety Net

**Why:** Today `src/lib/db/index.ts:17` caps Postgres at 10 connections in prod, and `src/workers/index.ts:251` runs `agent-run` at concurrency 8. One user spawning 5 teammates issues ~15 concurrent writes, exhausting the pool. There's no per-tenant in-flight cap, no LLM-side concurrency control, and lead messages queue FIFO behind teammate fan-outs. We install a Lua-scripted per-tenant semaphore, a hierarchical Anthropic token bucket, and split `agent-run` into three priority lanes.

**Outcome:** No tenant can exceed N in-flight agent-runs. No global LLM request burst can exceed Anthropic's tier ceiling. Founder-facing lead-message latency stays bounded even when other users fan out heavily.

---

### Task B1: Bump Postgres pool + enable prompt caching cleanup

**Files:**
- Modify: `src/lib/db/index.ts`
- Modify: `.env.example` (document new vars)

**Rationale:** Cheapest possible win. Pool 10 → 30 needs no code refactor — verify Supabase tier supports it first. Prompt caching is already wired in `src/core/api-client.ts:158-178` but only on the singleton `createMessage` path; audit for any direct `getClient().messages.create` callers that bypass it.

- [ ] **Step 1: Audit direct Anthropic SDK callers**

```bash
grep -rn "messages\.create\|messages\.stream" /Users/yifeng/Documents/Code/shipflare/src \
  --include='*.ts' \
  | grep -v "src/core/api-client.ts" \
  | grep -v "__tests__" \
  | grep -v "// " > /tmp/direct-anthropic-callers.txt
cat /tmp/direct-anthropic-callers.txt
```

Expected: empty or only the api-client itself. Any caller in the list must be refactored to go through `createMessage` (which enables prompt caching) before this task ships.

- [ ] **Step 2: Bump pool**

```ts
// src/lib/db/index.ts (line 12-18)
const client =
  globalForDb.pgClient ??
  postgres(connectionString, {
    prepare: false,
    ssl: 'require',
    max: process.env.NODE_ENV === 'production'
      ? parseInt(process.env.PG_POOL_MAX ?? '30', 10)
      : 1,
  });
```

- [ ] **Step 3: Document in .env.example**

```bash
# Add to .env.example
# Postgres connection pool size in production. Increase when adding workers
# or per-tenant concurrency. Must not exceed Supabase project max (Pro=400).
PG_POOL_MAX=30
```

- [ ] **Step 4: Verify Supabase project tier**

Manual: check Supabase dashboard → Database → Pooler. Confirm `max_clients` >= 30 for the project's pgbouncer in transaction mode. If not, file a tier-upgrade ticket before deploying.

- [ ] **Step 5: Type-check and commit**

```bash
bun run typecheck
git add src/lib/db/index.ts .env.example
git commit -m "config(db): make PG_POOL_MAX configurable, default 30 in prod"
```

---

### Task B2: Lua per-tenant in-flight semaphore

**Files:**
- Create: `src/lib/redis-scripts/tenant-semaphore.lua`
- Create: `src/lib/redis-scripts/tenant-semaphore.ts`
- Create: `src/lib/redis-scripts/__tests__/tenant-semaphore.test.ts`

**Rationale:** Atomic acquire/release scoped to a `userId`. Acquire returns `{ acquired: 0|1, current, cap }`. Release is unconditional `DECR` floored at 0. Keys include a TTL so a crashed worker can't permanently leak a slot — TTL is reset on every acquire to handle long-running jobs.

- [ ] **Step 1: Write the Lua script**

```lua
-- src/lib/redis-scripts/tenant-semaphore.lua
-- KEYS[1] = inflight key, e.g. "inflight:agent:user-abc"
-- ARGV[1] = cap (integer)
-- ARGV[2] = ttl seconds (integer) — slot dies if not released within this window
-- Returns: { acquired (0|1), current_count, cap }

local key = KEYS[1]
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key)) or 0

if current >= cap then
  return {0, current, cap}
end

local newval = redis.call('INCR', key)
redis.call('EXPIRE', key, ttl)
return {1, newval, cap}
```

- [ ] **Step 2: Write the TS wrapper test**

```ts
// src/lib/redis-scripts/__tests__/tenant-semaphore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { acquireTenantSlot, releaseTenantSlot } from '../tenant-semaphore';

describe('tenant-semaphore', () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const userId = 'test-user-' + crypto.randomUUID();

  beforeEach(async () => {
    await redis.del(`inflight:agent:${userId}`);
  });

  it('acquires up to cap, refuses beyond, releases let next through', async () => {
    const cap = 3;
    const ttl = 60;
    const a = await acquireTenantSlot(redis, userId, cap, ttl);
    const b = await acquireTenantSlot(redis, userId, cap, ttl);
    const c = await acquireTenantSlot(redis, userId, cap, ttl);
    const d = await acquireTenantSlot(redis, userId, cap, ttl);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(true);
    expect(d.acquired).toBe(false);
    expect(d.current).toBe(3);

    await releaseTenantSlot(redis, userId);
    const e = await acquireTenantSlot(redis, userId, cap, ttl);
    expect(e.acquired).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun run test src/lib/redis-scripts/__tests__/tenant-semaphore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement TS wrapper**

```ts
// src/lib/redis-scripts/tenant-semaphore.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('redis-scripts:tenant-semaphore');

const SCRIPT = readFileSync(
  join(import.meta.dir ?? __dirname, 'tenant-semaphore.lua'),
  'utf8',
);
const COMMAND_NAME = 'tenantSemaphoreAcquire';

function ensureCommand(redis: Redis): void {
  // ioredis: defineCommand is idempotent on the same instance, but cheap to guard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (redis as any)[COMMAND_NAME] === 'function') return;
  redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: SCRIPT });
}

export interface AcquireResult {
  acquired: boolean;
  current: number;
  cap: number;
}

export async function acquireTenantSlot(
  redis: Redis,
  userId: string,
  cap: number,
  ttlSeconds: number,
): Promise<AcquireResult> {
  ensureCommand(redis);
  const key = `inflight:agent:${userId}`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await (redis as any)[COMMAND_NAME](key, cap, ttlSeconds)) as [
      number,
      number,
      number,
    ];
    return { acquired: raw[0] === 1, current: raw[1], cap: raw[2] };
  } catch (err) {
    log.warn(
      `tenant-semaphore acquire failed for ${userId}, failing open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { acquired: true, current: 0, cap };
  }
}

export async function releaseTenantSlot(redis: Redis, userId: string): Promise<void> {
  const key = `inflight:agent:${userId}`;
  try {
    const newval = await redis.decr(key);
    if (newval < 0) await redis.set(key, '0');
  } catch (err) {
    log.warn(
      `tenant-semaphore release failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

- [ ] **Step 5: Run test**

```bash
bun run test src/lib/redis-scripts/__tests__/tenant-semaphore.test.ts
```

Expected: PASS (requires a local Redis running — start with `redis-server` if needed).

- [ ] **Step 6: Commit**

```bash
git add src/lib/redis-scripts/tenant-semaphore.lua \
        src/lib/redis-scripts/tenant-semaphore.ts \
        src/lib/redis-scripts/__tests__/tenant-semaphore.test.ts
git commit -m "feat(rate-limit): atomic per-tenant in-flight semaphore in Redis Lua"
```

---

### Task B3: Wire the semaphore into the agent-run worker

**Files:**
- Modify: `src/workers/processors/agent-run.ts`
- Modify: `src/lib/team/team-tier.ts` (create — maps userId → tier cap)
- Create: `src/lib/team/__tests__/team-tier.test.ts`

**Rationale:** At the top of `processAgentRun`, look up the user's tier cap, attempt to acquire. On refusal, re-enqueue the job with a small delay + jitter (Stripe-style backpressure) and exit without doing LLM work. On success, run normally; in a `try/finally`, release on exit (success, failure, OR yield-to-sleep). The semaphore counts USERS (one user's lead + teammates share a quota), not individual agents.

- [ ] **Step 1: Define tier mapping**

```ts
// src/lib/team/team-tier.ts
import { db } from '@/lib/db';
import { agentRuns, teamMembers, teams } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export type Tier = 'free' | 'paid' | 'premium';

const CAP_BY_TIER: Record<Tier, number> = {
  free: 3,
  paid: 10,
  premium: 25,
};

export function inflightCapForTier(tier: Tier): number {
  return CAP_BY_TIER[tier];
}

/**
 * Look up the user-tier for the user that owns the given agent_run.
 * For Phase B, every user is `free` — when billing lands, this reads
 * `users.tier` instead.
 */
export async function tierForAgentRun(agentId: string): Promise<{
  userId: string;
  tier: Tier;
}> {
  const rows = await db
    .select({
      userId: teams.userId,
    })
    .from(agentRuns)
    .innerJoin(teamMembers, eq(agentRuns.memberId, teamMembers.id))
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  const userId = rows[0]?.userId;
  if (!userId) throw new Error(`tierForAgentRun: agent ${agentId} has no userId`);
  // Until billing: hardcode `free`. Replace with `users.tier` lookup later.
  return { userId, tier: 'free' };
}
```

- [ ] **Step 2: Add re-enqueue helper**

```ts
// Add to src/lib/queue/agent-run.ts at the end of file
export async function reenqueueWithDelay(
  agentId: string,
  delayMs: number,
): Promise<void> {
  const jitter = Math.floor(Math.random() * 500);
  const bucket = Math.floor((Date.now() + delayMs) / 1000);
  await enqueueAgentRun(
    { agentId },
    { jobId: `delayed:${agentId}:${bucket}`, delay: delayMs + jitter },
  );
}
```

- [ ] **Step 3: Wire into processAgentRun**

In `src/workers/processors/agent-run.ts`, find the top of `processAgentRun` (the exported function the worker calls). Add at the very top, before any DB read:

```ts
import { getKeyValueClient } from '@/lib/redis';
import { acquireTenantSlot, releaseTenantSlot } from '@/lib/redis-scripts/tenant-semaphore';
import { tierForAgentRun, inflightCapForTier } from '@/lib/team/team-tier';
import { reenqueueWithDelay } from '@/lib/queue/agent-run';

const SEMAPHORE_TTL_SECONDS = 900; // 15 min — must exceed lockDuration (10 min)
const BACKPRESSURE_DELAY_MS = 1500;

export async function processAgentRun(job: Job<AgentRunJobData>): Promise<void> {
  const { agentId } = job.data;
  const { userId, tier } = await tierForAgentRun(agentId);
  const cap = inflightCapForTier(tier);
  const redis = getKeyValueClient();

  const slot = await acquireTenantSlot(redis, userId, cap, SEMAPHORE_TTL_SECONDS);
  if (!slot.acquired) {
    log.info(`backpressure: user=${userId} at cap=${cap}, re-enqueueing agent=${agentId}`);
    await reenqueueWithDelay(agentId, BACKPRESSURE_DELAY_MS);
    return;
  }

  try {
    await runAgentTurn(agentId, job); // <-- existing body moved into a helper
  } finally {
    await releaseTenantSlot(redis, userId);
  }
}
```

Refactor the existing body into a private `runAgentTurn(agentId, job)` helper. Be careful: the existing code touches `job.data` and module-level state; preserve all behavior, only relocate.

- [ ] **Step 4: Test the integration**

```ts
// src/lib/team/__tests__/team-tier.test.ts
import { describe, it, expect } from 'vitest';
import { inflightCapForTier } from '../team-tier';

describe('inflightCapForTier', () => {
  it('returns the documented caps', () => {
    expect(inflightCapForTier('free')).toBe(3);
    expect(inflightCapForTier('paid')).toBe(10);
    expect(inflightCapForTier('premium')).toBe(25);
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

```bash
bun run test src/lib/team/__tests__/team-tier.test.ts
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/team/team-tier.ts src/lib/team/__tests__/team-tier.test.ts \
        src/lib/queue/agent-run.ts src/workers/processors/agent-run.ts
git commit -m "feat(agent-run): per-tenant in-flight cap + backpressure re-enqueue"
```

---

### Task B4: Hierarchical Anthropic token bucket (Lua)

**Files:**
- Create: `src/lib/redis-scripts/llm-token-bucket.lua`
- Create: `src/lib/redis-scripts/llm-token-bucket.ts`
- Create: `src/lib/redis-scripts/__tests__/llm-token-bucket.test.ts`

**Rationale:** Per-tenant + global token-bucket gated atomically in one Lua call. If global allows but tenant exceeds → refuse and refund nothing. If tenant allows but global exceeds → refund the tenant. Bucket key holds `tokens` + `last_refill_ts`. Refill rate is `cap / window_seconds`. We track REQUESTS (not LLM tokens) — finer-grained TPM gating requires pre-flight token estimation which we defer to Phase C (LiteLLM handles it).

- [ ] **Step 1: Write the Lua script**

```lua
-- src/lib/redis-scripts/llm-token-bucket.lua
-- Atomic two-level token bucket (tenant + global).
--
-- KEYS[1] = tenant bucket key,  e.g. "llm:tenant:user-abc"
-- KEYS[2] = global bucket key,  e.g. "llm:global:anthropic"
-- ARGV[1] = tenant cap          (integer)
-- ARGV[2] = tenant refill/sec   (float; ARGV is string, tonumber to float)
-- ARGV[3] = global cap          (integer)
-- ARGV[4] = global refill/sec   (float)
-- ARGV[5] = now (ms)            (integer)
-- ARGV[6] = cost                (integer, normally 1)
--
-- Returns: { 1, tenant_remaining, global_remaining }  on allow
--          { 0, "tenant"|"global", retry_ms }          on deny

local function refill(key, cap, rate_per_sec, now_ms, cost)
  local data = redis.call('HMGET', key, 't', 'ts')
  local tokens = tonumber(data[1])
  local last = tonumber(data[2])
  if tokens == nil or last == nil then
    tokens = cap
    last = now_ms
  end
  local elapsed_sec = (now_ms - last) / 1000.0
  tokens = math.min(cap, tokens + elapsed_sec * rate_per_sec)
  if tokens < cost then
    local need = cost - tokens
    local retry_ms = math.ceil((need / rate_per_sec) * 1000)
    return {false, tokens, retry_ms}
  end
  tokens = tokens - cost
  redis.call('HMSET', key, 't', tokens, 'ts', now_ms)
  redis.call('EXPIRE', key, 3600)
  return {true, tokens, 0}
end

local cost = tonumber(ARGV[6])

local t = refill(KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[5]), cost)
if not t[1] then
  return {0, 'tenant', t[3]}
end

local g = refill(KEYS[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), cost)
if not g[1] then
  -- Refund the tenant slot we just took
  redis.call('HINCRBY', KEYS[1], 't', cost)
  return {0, 'global', g[3]}
end

return {1, t[2], g[2]}
```

- [ ] **Step 2: Write the TS wrapper test**

```ts
// src/lib/redis-scripts/__tests__/llm-token-bucket.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { tryAcquireLlmTokens } from '../llm-token-bucket';

describe('llm-token-bucket', () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const userId = 'u-' + crypto.randomUUID();
  beforeEach(async () => {
    await redis.del(`llm:tenant:${userId}`, `llm:global:test`);
  });

  it('allows up to tenant cap, then denies with retry_ms', async () => {
    const opts = {
      tenantKey: `llm:tenant:${userId}`,
      tenantCap: 5,
      tenantRefillPerSec: 0.1,
      globalKey: `llm:global:test`,
      globalCap: 1000,
      globalRefillPerSec: 100,
    };
    for (let i = 0; i < 5; i++) {
      const r = await tryAcquireLlmTokens(redis, opts);
      expect(r.allowed).toBe(true);
    }
    const denied = await tryAcquireLlmTokens(redis, opts);
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('tenant');
    expect(denied.retryMs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun run test src/lib/redis-scripts/__tests__/llm-token-bucket.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement TS wrapper**

```ts
// src/lib/redis-scripts/llm-token-bucket.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('redis-scripts:llm-token-bucket');

const SCRIPT = readFileSync(
  join(import.meta.dir ?? __dirname, 'llm-token-bucket.lua'),
  'utf8',
);

const COMMAND_NAME = 'llmTokenBucketAcquire';

function ensureCommand(redis: Redis): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (redis as any)[COMMAND_NAME] === 'function') return;
  redis.defineCommand(COMMAND_NAME, { numberOfKeys: 2, lua: SCRIPT });
}

export interface AcquireLlmOptions {
  tenantKey: string;
  tenantCap: number;
  tenantRefillPerSec: number;
  globalKey: string;
  globalCap: number;
  globalRefillPerSec: number;
  cost?: number;
}

export type AcquireLlmResult =
  | { allowed: true; tenantRemaining: number; globalRemaining: number }
  | { allowed: false; scope: 'tenant' | 'global'; retryMs: number };

export async function tryAcquireLlmTokens(
  redis: Redis,
  opts: AcquireLlmOptions,
): Promise<AcquireLlmResult> {
  ensureCommand(redis);
  const cost = opts.cost ?? 1;
  const now = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (await (redis as any)[COMMAND_NAME](
      opts.tenantKey,
      opts.globalKey,
      opts.tenantCap,
      opts.tenantRefillPerSec,
      opts.globalCap,
      opts.globalRefillPerSec,
      now,
      cost,
    )) as [number, number | string, number];

    if (raw[0] === 1) {
      return {
        allowed: true,
        tenantRemaining: raw[1] as number,
        globalRemaining: raw[2] as number,
      };
    }
    return {
      allowed: false,
      scope: raw[1] as 'tenant' | 'global',
      retryMs: raw[2],
    };
  } catch (err) {
    log.warn(
      `llm-token-bucket acquire failed, failing open: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { allowed: true, tenantRemaining: 0, globalRemaining: 0 };
  }
}
```

- [ ] **Step 5: Run test**

```bash
bun run test src/lib/redis-scripts/__tests__/llm-token-bucket.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/redis-scripts/llm-token-bucket.lua \
        src/lib/redis-scripts/llm-token-bucket.ts \
        src/lib/redis-scripts/__tests__/llm-token-bucket.test.ts
git commit -m "feat(rate-limit): hierarchical Anthropic token bucket Lua"
```

---

### Task B5: Wire the token bucket into api-client

**Files:**
- Modify: `src/core/api-client.ts`
- Modify: `src/core/types.ts` (add `tenantId?` to CreateMessageOptions)
- Modify: `src/core/__tests__/api-client-rate-limit.test.ts` (create)
- Modify: every call site that passes opts to `createMessage` to forward `tenantId`

**Rationale:** Each Anthropic call must do an atomic acquire. On deny, throw a typed error the caller can map to a re-enqueue (workers) or 429 (HTTP routes). On allow, proceed; on the response we DO NOT refund — the call already happened. The `tenantId` is the shipflare userId; reads from existing call-site context.

- [ ] **Step 1: Add the tenantId option to types**

```ts
// src/core/api-client.ts (line 104, inside CreateMessageOptions)
export interface CreateMessageOptions {
  // ... existing fields ...
  /**
   * Shipflare userId. When provided, each call decrements a per-tenant
   * + global Anthropic token bucket via Redis Lua. Throws
   * `LlmRateLimitedError` on deny.
   */
  tenantId?: string;
}
```

- [ ] **Step 2: Define the error type**

```ts
// Add to src/core/api-client.ts (top of file, after imports)
export class LlmRateLimitedError extends Error {
  constructor(
    public readonly scope: 'tenant' | 'global',
    public readonly retryMs: number,
  ) {
    super(`llm_rate_limited:${scope} retry in ${retryMs}ms`);
    this.name = 'LlmRateLimitedError';
  }
}
```

- [ ] **Step 3: Acquire at the top of createMessage**

```ts
// In src/core/api-client.ts, inside createMessage(), before the retry loop
import { getKeyValueClient } from '@/lib/redis';
import { tryAcquireLlmTokens } from '@/lib/redis-scripts/llm-token-bucket';

// ... existing code ...

if (opts.tenantId) {
  const redis = getKeyValueClient();
  const tenantCap = parseInt(process.env.LLM_TENANT_RPM ?? '60', 10);
  const globalCap = parseInt(process.env.LLM_GLOBAL_RPM ?? '900', 10);
  const ack = await tryAcquireLlmTokens(redis, {
    tenantKey: `llm:tenant:${opts.tenantId}`,
    tenantCap,
    tenantRefillPerSec: tenantCap / 60,
    globalKey: `llm:global:anthropic`,
    globalCap,
    globalRefillPerSec: globalCap / 60,
  });
  if (!ack.allowed) {
    throw new LlmRateLimitedError(ack.scope, ack.retryMs);
  }
}
```

- [ ] **Step 4: Plumb tenantId through callers**

Search for all `createMessage(` calls:

```bash
grep -rn "createMessage(" /Users/yifeng/Documents/Code/shipflare/src --include='*.ts' | grep -v "__tests__\|api-client.ts"
```

For each call site, plumb the user's `tenantId` (the shipflare `userId`) from the closest available context — usually `ctx.userId`, `job.data.userId`, or derived via `tierForAgentRun(agentId)` (Task B3). Worker call sites already have agentId → use `tierForAgentRun` to resolve. Skill / agent forks: thread `tenantId` through `runAgent` → `core/query-loop.ts` → eventually `createMessage`. Add a required `tenantId` field to whatever options shape is closest to `runAgent` so it can't be forgotten.

- [ ] **Step 5: Handle LlmRateLimitedError in the agent-run worker**

In `src/workers/processors/agent-run.ts`, wrap the inner runAgent in a catch that re-enqueues on rate-limit:

```ts
import { LlmRateLimitedError } from '@/core/api-client';

try {
  await runAgentTurn(agentId, job);
} catch (err) {
  if (err instanceof LlmRateLimitedError) {
    log.info(`llm-rate-limited(${err.scope}): re-enqueue agent=${agentId} after ${err.retryMs}ms`);
    await reenqueueWithDelay(agentId, err.retryMs);
    return;
  }
  throw err;
}
```

(This sits inside the semaphore try/finally block from B3 so the in-flight slot is released first.)

- [ ] **Step 6: Test**

```ts
// src/core/__tests__/api-client-rate-limit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LlmRateLimitedError } from '../api-client';

describe('LlmRateLimitedError', () => {
  it('carries scope and retryMs', () => {
    const err = new LlmRateLimitedError('tenant', 1500);
    expect(err.scope).toBe('tenant');
    expect(err.retryMs).toBe(1500);
    expect(err.name).toBe('LlmRateLimitedError');
  });
});
```

```bash
bun run test src/core/__tests__/api-client-rate-limit.test.ts
bun run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/core/api-client.ts src/core/__tests__/api-client-rate-limit.test.ts \
        src/workers/processors/agent-run.ts \
        # plus any caller files plumbed in step 4
git commit -m "feat(llm): hierarchical token bucket on every Anthropic call"
```

---

### Task B6: Split agent-run queue into priority lanes

**Files:**
- Modify: `src/lib/queue/agent-run.ts`
- Modify: `src/workers/index.ts`
- Modify: `src/workers/processors/lib/wake.ts`
- Modify: every wake() caller that needs to specify priority

**Rationale:** One BullMQ queue with FIFO ordering means a teammate-spawn batch can sit ahead of a fresh founder message. Split into three queues sharing the same `processAgentRun`:
- `agent-run-priority` (founder → lead): concurrency 4, drains first
- `agent-run-standard` (teammate spawns, peer DMs): concurrency 6
- `agent-run-backfill` (cron-triggered, e.g. weekly-replan): concurrency 2

This is Stripe's critical/non-critical pattern. The semaphore from B3 still caps per-tenant in-flight across all three queues.

- [ ] **Step 1: Define three queues**

```ts
// src/lib/queue/agent-run.ts — replace the single queue export
export type AgentRunPriority = 'priority' | 'standard' | 'backfill';

const QUEUE_NAMES: Record<AgentRunPriority, string> = {
  priority: 'agent-run-priority',
  standard: 'agent-run-standard',
  backfill: 'agent-run-backfill',
};

export const AGENT_RUN_QUEUE_NAMES = QUEUE_NAMES;

// Keep the old export for backward compat during migration
export const AGENT_RUN_QUEUE_NAME = QUEUE_NAMES.standard;

const queues: Record<AgentRunPriority, Queue<AgentRunJobData>> = {
  priority: new Queue<AgentRunJobData>(QUEUE_NAMES.priority, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 3600 },
      removeOnFail: { count: 500, age: 86400 },
      attempts: 1,
    },
  }),
  standard: new Queue<AgentRunJobData>(QUEUE_NAMES.standard, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 3600 },
      removeOnFail: { count: 500, age: 86400 },
      attempts: 1,
    },
  }),
  backfill: new Queue<AgentRunJobData>(QUEUE_NAMES.backfill, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 3600 },
      removeOnFail: { count: 500, age: 86400 },
      attempts: 1,
    },
  }),
};

export const agentRunQueue = queues.standard; // legacy alias

export interface EnqueueAgentRunOptions {
  jobId?: string;
  delay?: number;
  priority?: AgentRunPriority;
}

export async function enqueueAgentRun(
  data: AgentRunJobData,
  opts: EnqueueAgentRunOptions = {},
): Promise<EnqueueAgentRunResult> {
  const priority: AgentRunPriority = opts.priority ?? 'standard';
  const queue = queues[priority];
  const jobId = opts.jobId ?? data.agentId;
  const job = await queue.add('run', data, {
    jobId,
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  });
  log.debug(`enqueueAgentRun: agentId=${data.agentId} priority=${priority} jobId=${jobId}${opts.delay ? ` delay=${opts.delay}ms` : ''}`);
  return { id: job.id, data };
}
```

- [ ] **Step 2: Spin up three workers**

```ts
// src/workers/index.ts — replace the single agentRunWorker
import { AGENT_RUN_QUEUE_NAMES, type AgentRunJobData } from '@/lib/queue/agent-run';

const PRIORITY_CONCURRENCY: Record<keyof typeof AGENT_RUN_QUEUE_NAMES, number> = {
  priority: 4,
  standard: 6,
  backfill: 2,
};

const agentRunWorkers = Object.entries(AGENT_RUN_QUEUE_NAMES).map(
  ([lane, name]) =>
    new Worker<AgentRunJobData>(
      name,
      async (job) => {
        const jobLog = loggerForJob(log, job);
        jobLog.info(`agent-run start lane=${lane} agentId=${job.data.agentId}`);
        await processAgentRun(job);
        jobLog.info(`agent-run done lane=${lane} agentId=${job.data.agentId}`);
      },
      {
        ...BASE_OPTS,
        concurrency: PRIORITY_CONCURRENCY[lane as keyof typeof PRIORITY_CONCURRENCY],
        lockDuration: 600_000,
      },
    ),
);

// Replace `agentRunWorker` in the `workers` array with `...agentRunWorkers`.
```

- [ ] **Step 3: Update wake() to accept priority**

```ts
// src/workers/processors/lib/wake.ts
import { enqueueAgentRun, type AgentRunPriority } from '@/lib/queue/agent-run';

export async function wake(
  agentId: string,
  priority: AgentRunPriority = 'standard',
): Promise<void> {
  const bucket = Math.floor(Date.now() / 1000);
  const jobId = `wake:${agentId}:${bucket}`;
  await enqueueAgentRun({ agentId }, { jobId, priority });
}
```

- [ ] **Step 4: Map call sites to lanes**

| Caller | File | Priority |
|---|---|---|
| Founder message via SendMessage UI route | `src/app/api/team/send-message/route.ts` (find it) | `priority` |
| Task tool async spawn (teammate) | `src/tools/AgentTool/AgentTool.ts` (launchAsyncTeammate) | `standard` |
| SendMessage tool — peer DM | `src/tools/SendMessageTool/SendMessageTool.ts` | `standard` |
| Sleep tool resume | wherever Sleep wakes | `standard` |
| Reconcile-mailbox cron | `src/workers/processors/reconcile-mailbox.ts` | `backfill` |
| Weekly-replan / cron triggers | various processors | `backfill` |

For each, pass `priority` to the `wake()` or `enqueueAgentRun()` call.

- [ ] **Step 5: Test**

```ts
// src/lib/queue/__tests__/agent-run-priority.test.ts
import { describe, it, expect } from 'vitest';
import { AGENT_RUN_QUEUE_NAMES } from '../agent-run';

describe('agent-run queues', () => {
  it('defines priority, standard, backfill lane names', () => {
    expect(AGENT_RUN_QUEUE_NAMES).toMatchObject({
      priority: 'agent-run-priority',
      standard: 'agent-run-standard',
      backfill: 'agent-run-backfill',
    });
  });
});
```

```bash
bun run test src/lib/queue/__tests__/agent-run-priority.test.ts
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/agent-run.ts src/workers/index.ts \
        src/workers/processors/lib/wake.ts \
        src/lib/queue/__tests__/agent-run-priority.test.ts \
        # + every wake() call-site touched in step 4
git commit -m "feat(workers): split agent-run into priority/standard/backfill lanes"
```

---

### Task B7: Heartbeat batching + observability metrics

**Files:**
- Create: `src/lib/team/agent-status-batcher.ts`
- Create: `src/lib/team/__tests__/agent-status-batcher.test.ts`
- Modify: `src/workers/processors/agent-run.ts` (use batcher for status writes)
- Create: `src/app/api/admin/queue-stats/route.ts` (basic metrics endpoint)

**Rationale:** Today every turn transition writes to `agent_runs` + Redis cache + SSE pub — three operations per transition. Batch the DB+cache writes per 500ms tick so a chatty 20-turn run does ~5 writes, not 60. SSE pubs stay realtime. Metrics endpoint exposes per-queue depth, in-flight counts per tier, and Anthropic bucket fill — basis for a Grafana board.

- [ ] **Step 1: Write the batcher with TDD**

```ts
// src/lib/team/__tests__/agent-status-batcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AgentStatusBatcher } from '../agent-status-batcher';

describe('AgentStatusBatcher', () => {
  it('coalesces multiple updates for the same agent into one flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 50, flush });
    batcher.set('a-1', { status: 'running', lastActiveAt: new Date() });
    batcher.set('a-1', { status: 'sleeping', lastActiveAt: new Date() });
    await new Promise((r) => setTimeout(r, 80));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toHaveLength(1); // one agent
    expect(flush.mock.calls[0][0][0].status).toBe('sleeping'); // last wins
    batcher.dispose();
  });
});
```

- [ ] **Step 2: Implement the batcher**

```ts
// src/lib/team/agent-status-batcher.ts
export interface StatusUpdate {
  status: string;
  lastActiveAt: Date;
  sleepUntil?: Date | null;
  shutdownReason?: string | null;
  totalTokens?: number;
  toolUses?: number;
}

export interface FlushPayload extends StatusUpdate {
  agentId: string;
}

export interface AgentStatusBatcherOptions {
  flushIntervalMs: number;
  flush: (payload: FlushPayload[]) => Promise<void>;
}

export class AgentStatusBatcher {
  private buffer = new Map<string, StatusUpdate>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: AgentStatusBatcherOptions) {
    this.timer = setInterval(() => {
      void this.flushNow();
    }, opts.flushIntervalMs);
  }

  set(agentId: string, update: StatusUpdate): void {
    this.buffer.set(agentId, update);
  }

  async flushNow(): Promise<void> {
    if (this.buffer.size === 0) return;
    const batch: FlushPayload[] = Array.from(this.buffer, ([agentId, u]) => ({
      agentId,
      ...u,
    }));
    this.buffer.clear();
    try {
      await this.opts.flush(batch);
    } catch (err) {
      // Re-buffer on failure; next tick will retry.
      for (const item of batch) {
        if (!this.buffer.has(item.agentId)) {
          this.buffer.set(item.agentId, item);
        }
      }
      throw err;
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    void this.flushNow();
  }
}
```

- [ ] **Step 3: Wire into agent-run.ts**

Add a module-level singleton batcher; replace existing `db.update(agentRuns).set(...)` for status transitions with `batcher.set(agentId, { ... })`. Keep terminal-state writes (completed / failed / killed) synchronous — those must be durable before the worker returns.

- [ ] **Step 4: Metrics endpoint**

```ts
// src/app/api/admin/queue-stats/route.ts
import { NextResponse } from 'next/server';
import { getKeyValueClient } from '@/lib/redis';
import { agentRunQueue } from '@/lib/queue/agent-run';
import { auth } from '@/auth';

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Admin gate — replace with your existing admin check
  const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '').split(',');
  if (!ADMIN_EMAILS.includes(session.user.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const redis = getKeyValueClient();
  const [counts, inflightKeys] = await Promise.all([
    agentRunQueue.getJobCounts(),
    redis.keys('inflight:agent:*'),
  ]);
  const inflightTotals = await Promise.all(
    inflightKeys.map(async (k) => ({ key: k, n: parseInt((await redis.get(k)) ?? '0', 10) })),
  );

  return NextResponse.json({
    queueCounts: counts,
    inflightByTenant: inflightTotals,
    timestamp: new Date().toISOString(),
  });
}
```

- [ ] **Step 5: Test + typecheck**

```bash
bun run test src/lib/team/__tests__/agent-status-batcher.test.ts
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/team/agent-status-batcher.ts \
        src/lib/team/__tests__/agent-status-batcher.test.ts \
        src/workers/processors/agent-run.ts \
        src/app/api/admin/queue-stats/route.ts
git commit -m "perf(team): batch agent-run status writes + add admin queue-stats endpoint"
```

---

### Task B8: Multi-user real-browser smoke test

**Files:**
- Create: `e2e/tests/multi-tenant-fairness.spec.ts`

**Rationale:** Prove the safety net works against a real local stack. Two parallel browser contexts simulate two users. User A spawns a heavy teammate fan-out. User B sends a fresh founder message. Assert: B's lead message gets a first-token response in < 5s wall-clock even while A is mid-fan-out.

- [ ] **Step 1: Write the test**

```ts
// e2e/tests/multi-tenant-fairness.spec.ts
import { test, expect, type BrowserContext } from '@playwright/test';

async function sendMessage(ctx: BrowserContext, text: string): Promise<void> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('http://localhost:3000/team');
  await page.getByPlaceholder(/Message your team/i).fill(text);
  await page.keyboard.press('Enter');
}

test('user B lead response not blocked by user A fan-out', async ({ browser }) => {
  // Two contexts = two authenticated users. Assumes both have been seeded.
  const ctxA = await browser.newContext({
    storageState: 'e2e/auth/user-a.json',
  });
  const ctxB = await browser.newContext({
    storageState: 'e2e/auth/user-b.json',
  });

  // User A: kick off a heavy fan-out
  await sendMessage(
    ctxA,
    'Find threads on Reddit and X about my product, draft reply suggestions for top 10',
  );
  // Give A a 2s head-start so its teammates are mid-spawn
  await new Promise((r) => setTimeout(r, 2000));

  // User B: send a fresh founder message and time first token
  const pageB = ctxB.pages()[0] ?? (await ctxB.newPage());
  await pageB.goto('http://localhost:3000/team');
  const t0 = Date.now();
  await pageB.getByPlaceholder(/Message your team/i).fill('Hi, status update please');
  await pageB.keyboard.press('Enter');
  // First lead message bubble should appear
  await expect(pageB.locator('[data-role="lead-message"]').first()).toBeVisible({
    timeout: 8000,
  });
  const t1 = Date.now();
  expect(t1 - t0).toBeLessThan(5000); // first byte under 5s while A is mid-fan-out
});
```

- [ ] **Step 2: Seed two test users**

You need two user storage states. Use the existing `bun run scripts/seed-user.ts` twice (Task says it exists per earlier grep) and write each authenticated session via Playwright codegen → save to `e2e/auth/user-a.json` and `e2e/auth/user-b.json`.

- [ ] **Step 3: Run the test against the live stack**

```bash
# Terminal 1
bun run dev
# Terminal 2
bun run test:e2e:live -- --grep "user B lead response not blocked"
```

Expected: PASS (within 5s threshold).

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/multi-tenant-fairness.spec.ts e2e/auth/.gitignore
git commit -m "test(e2e): multi-tenant fairness smoke — user B unblocked by A"
```


## Phase D — Durable Lead Orchestrator (3A)

**Why:** Today `src/workers/processors/agent-run.ts` holds a BullMQ worker slot for the entire lead-interaction wall-clock — when a lead spawns 5 teammates and waits for them, the lead's worker slot stays occupied for 30s-5min. Across multiple users this caps the system at `concurrency` simultaneous lead conversations. The fix: refactor the lead's loop into a one-step state machine that, on a "spawn-and-wait" decision, persists `waiting_for: [agentId, ...]` to `agent_runs`, releases the worker slot, and exits. When a teammate completes, its `synthAndDeliverNotification` re-enqueues the parent. The mailbox poll timer goes away.

**Outcome:** A user's lead consumes worker compute only during its own LLM-decision turns. 100 simultaneous lead conversations all in "waiting for teammates" state cost zero worker slots.

---

### Task D1: Migration — add checkpoint + waiting_for to agent_runs

**Files:**
- Create: `scripts/migrations/2026-05-XX-agent-runs-checkpoint.sql`
- Modify: `src/lib/db/schema/team.ts`

**Rationale:** `checkpoint JSONB` stores whatever the lead's pure step function needs to resume (last assistant message, tool-use index, accumulated state). `waiting_for TEXT[]` is the set of teammate agentIds the lead is waiting on; empty array = no wait. `next_wake_at TIMESTAMPTZ` for Sleep-style scheduled resumes. Index on `waiting_for` for the "which leads are unblocked by this completion" query.

- [ ] **Step 1: Write the migration**

```sql
-- scripts/migrations/2026-05-XX-agent-runs-checkpoint.sql
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS checkpoint JSONB,
  ADD COLUMN IF NOT EXISTS waiting_for TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS next_wake_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_runs_waiting_for
  ON agent_runs USING gin(waiting_for)
  WHERE cardinality(waiting_for) > 0;

CREATE INDEX IF NOT EXISTS idx_agent_runs_next_wake_at
  ON agent_runs(next_wake_at)
  WHERE next_wake_at IS NOT NULL;

-- Lead runs now have a new terminal-adjacent state.
-- Allowed transitions:
--   queued → running
--   running → waiting_for_children (new: lead spawned, yielded)
--   running → sleeping
--   running → completed | failed | killed
--   waiting_for_children → running (child completed, re-enqueue fired)
--   sleeping → running (next_wake_at elapsed)
COMMENT ON COLUMN agent_runs.checkpoint IS 'Lead step-function state for resume after waiting_for_children → running transition. Null for legacy single-shot teammates.';
COMMENT ON COLUMN agent_runs.waiting_for IS 'Array of agent_runs.id this lead is waiting on. Re-enqueued when array becomes empty.';
```

- [ ] **Step 2: Update Drizzle schema**

```ts
// src/lib/db/schema/team.ts — inside agentRuns table
// (add inside the columns object, before the closing parens)
checkpoint: jsonb('checkpoint').$type<LeadCheckpoint | null>(),
waitingFor: text('waiting_for').array().notNull().default([]),
nextWakeAt: timestamp('next_wake_at', { withTimezone: true }),
```

```ts
// Also export the type
export interface LeadCheckpoint {
  /** Last index into the assistant-message history we've processed. */
  lastProcessedIndex: number;
  /** Tool-use IDs we've issued Task() calls for but not yet seen results. */
  pendingToolUseIds: string[];
  /** Accumulated state passed to the next step. */
  state: Record<string, unknown>;
}
```

- [ ] **Step 3: Run + commit**

```bash
bun run scripts/run-migrations.ts
bun run typecheck
git add scripts/migrations/2026-05-XX-agent-runs-checkpoint.sql \
        src/lib/db/schema/team.ts
git commit -m "feat(team): agent_runs checkpoint + waiting_for + next_wake_at columns"
```

---

### Task D2: Extract lead loop into a pure step function

**Files:**
- Create: `src/workers/processors/lead-step.ts`
- Create: `src/workers/processors/__tests__/lead-step.test.ts`

**Rationale:** The existing `agent-run.ts` body is one long imperative loop. We extract the decision-making into a pure function: input = `{ history, mailbox, checkpoint }`, output = a discriminated-union `StepDecision`:
- `{ kind: 'continue', messages }` — produce more messages, no spawn, no yield
- `{ kind: 'spawn_and_wait', toolUses, newCheckpoint }` — spawn teammates, persist, exit
- `{ kind: 'sleep', untilMs, newCheckpoint }` — schedule resume
- `{ kind: 'done', summary }` — terminal

This separates "decide what to do next" (pure, testable) from "execute the decision" (impure, persists, enqueues).

- [ ] **Step 1: Define the types**

```ts
// src/workers/processors/lead-step.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { LeadCheckpoint } from '@/lib/db/schema/team';

export interface LeadStepInput {
  agentId: string;
  history: Anthropic.Messages.MessageParam[];
  mailbox: DrainedMessage[]; // from drainMailbox
  checkpoint: LeadCheckpoint | null;
  tenantId: string;
}

export type LeadStepDecision =
  | { kind: 'continue'; assistantMessages: Anthropic.Messages.MessageParam[]; newCheckpoint: LeadCheckpoint }
  | { kind: 'spawn_and_wait'; spawns: SpawnRequest[]; newCheckpoint: LeadCheckpoint }
  | { kind: 'sleep'; untilMs: number; newCheckpoint: LeadCheckpoint }
  | { kind: 'done'; summary: string };

export interface SpawnRequest {
  toolUseId: string;
  agentType: string;
  prompt: string;
}

import { drainMailbox, type DrainedMessage } from './lib/mailbox-drain';
import { createMessage } from '@/core/api-client';
// ... (more imports as the body grows)

/**
 * Pure step function — decides the next action for a lead given current state.
 * Side effects (LLM call) are isolated; persisting + enqueueing is the caller's
 * responsibility.
 */
export async function leadStep(input: LeadStepInput): Promise<LeadStepDecision> {
  // ... call createMessage with input.history + input.mailbox
  // ... inspect the response tool_uses
  // ... if any are async Task() calls, return spawn_and_wait
  // ... if a Sleep() call, return sleep
  // ... if no tool_use blocks, return done
  // ... otherwise (sync tool calls), return continue with the assistant message
  // Implementation lifted from the existing runAgentTurn body — preserve all
  // existing logic. This task is purely a re-org, not a behavior change.
  throw new Error('TODO: port body from agent-run.ts runAgentTurn');
}
```

- [ ] **Step 2: Port the body from agent-run.ts**

Read `src/workers/processors/agent-run.ts` end-to-end. Find the section that:
1. Loads history
2. Drains mailbox
3. Calls runAgent / createMessage
4. Inspects response for Task / Sleep / terminal

Lift each into `leadStep()` and return the appropriate `LeadStepDecision` discriminant. Do NOT change semantics; this task is a refactor only.

- [ ] **Step 3: Unit test the pure function**

```ts
// src/workers/processors/__tests__/lead-step.test.ts
import { describe, it, expect, vi } from 'vitest';
import { leadStep } from '../lead-step';

// Mock createMessage to return controlled responses
vi.mock('@/core/api-client', () => ({
  createMessage: vi.fn(),
}));

describe('leadStep', () => {
  it('returns spawn_and_wait when LLM emits async Task tool_use', async () => {
    // Arrange: mock createMessage to return a response with a Task tool_use
    // that has run_in_background: true
    // ...
    const result = await leadStep({
      agentId: 'a-1',
      history: [],
      mailbox: [],
      checkpoint: null,
      tenantId: 'u-1',
    });
    expect(result.kind).toBe('spawn_and_wait');
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
bun run test src/workers/processors/__tests__/lead-step.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/workers/processors/lead-step.ts \
        src/workers/processors/__tests__/lead-step.test.ts
git commit -m "refactor(agent-run): extract leadStep pure decision function"
```

---

### Task D3: Refactor processor to "run one step, persist, return"

**Files:**
- Modify: `src/workers/processors/agent-run.ts`

**Rationale:** The processor now becomes a thin dispatcher:
1. Acquire semaphore (B3)
2. Load history + checkpoint + drain mailbox
3. Call `leadStep(...)`
4. Apply the decision:
   - `continue` → persist assistant messages, optionally re-enqueue self if mailbox has more
   - `spawn_and_wait` → INSERT teammate agent_runs rows, push initial prompts to team_messages, SET this lead's `waiting_for = [agentId, ...]`, status='waiting_for_children', RETURN
   - `sleep` → SET `sleep_until`, status='sleeping', RETURN
   - `done` → SET status='completed', RETURN
5. Release semaphore

The drain-poll timer (`DRAIN_POLL_INTERVAL_MS = 1000`) goes away. Mail is drained once per wake.

- [ ] **Step 1: Rewrite processAgentRun**

```ts
// src/workers/processors/agent-run.ts (top-level outline)
export async function processAgentRun(job: Job<AgentRunJobData>): Promise<void> {
  const { agentId } = job.data;
  const { userId, tier } = await tierForAgentRun(agentId);
  const cap = inflightCapForTier(tier);
  const redis = getKeyValueClient();

  const slot = await acquireTenantSlot(redis, userId, cap, SEMAPHORE_TTL_SECONDS);
  if (!slot.acquired) {
    await reenqueueWithDelay(agentId, BACKPRESSURE_DELAY_MS);
    return;
  }

  try {
    // 1. Load current state
    const run = await loadAgentRun(agentId); // helper — selects from agent_runs
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'killed') {
      return; // terminal — no-op (idempotent wake)
    }
    if (run.status === 'waiting_for_children' && run.waitingFor.length > 0) {
      return; // still waiting — caller's re-enqueue was racy. No-op.
    }

    const history = await loadAgentRunHistory(agentId);
    const mailbox = await drainMailbox(agentId, db);

    // 2. Decide
    const decision = await leadStep({
      agentId,
      history,
      mailbox,
      checkpoint: run.checkpoint,
      tenantId: userId,
    });

    // 3. Apply
    switch (decision.kind) {
      case 'continue': {
        await persistAssistantMessages(agentId, decision.assistantMessages);
        await db.update(agentRuns)
          .set({ checkpoint: decision.newCheckpoint, lastActiveAt: new Date() })
          .where(eq(agentRuns.id, agentId));
        // If mailbox has more messages addressed since drain, self-re-enqueue
        // is unnecessary — the SendMessage that delivered them already called
        // wake() with our agentId.
        break;
      }
      case 'spawn_and_wait': {
        const spawnedIds: string[] = [];
        for (const spawn of decision.spawns) {
          const childId = await spawnTeammate({
            parentAgentId: agentId,
            parentToolUseId: spawn.toolUseId,
            agentType: spawn.agentType,
            prompt: spawn.prompt,
          });
          spawnedIds.push(childId);
        }
        await db.update(agentRuns)
          .set({
            status: 'waiting_for_children',
            waitingFor: spawnedIds,
            checkpoint: decision.newCheckpoint,
            lastActiveAt: new Date(),
          })
          .where(eq(agentRuns.id, agentId));
        break;
      }
      case 'sleep': {
        await db.update(agentRuns)
          .set({
            status: 'sleeping',
            sleepUntil: new Date(decision.untilMs),
            nextWakeAt: new Date(decision.untilMs),
            checkpoint: decision.newCheckpoint,
            lastActiveAt: new Date(),
          })
          .where(eq(agentRuns.id, agentId));
        await reenqueueWithDelay(agentId, decision.untilMs - Date.now());
        break;
      }
      case 'done': {
        await db.update(agentRuns)
          .set({
            status: 'completed',
            shutdownReason: decision.summary,
            lastActiveAt: new Date(),
          })
          .where(eq(agentRuns.id, agentId));
        // Notify parent if this is a teammate
        if (run.parentAgentId) {
          await synthAndDeliverNotification({
            parentAgentId: run.parentAgentId,
            childAgentId: agentId,
            parentToolUseId: run.parentToolUseId,
            summary: decision.summary,
          });
        }
        break;
      }
    }
  } finally {
    await releaseTenantSlot(redis, userId);
  }
}
```

- [ ] **Step 2: Add helpers (loadAgentRun, persistAssistantMessages, spawnTeammate)**

Each is straightforward Drizzle. `spawnTeammate` is essentially the existing `AgentTool.launchAsyncTeammate` body — lift it or import.

- [ ] **Step 3: Type-check and existing-test sweep**

```bash
bun run typecheck
bun run test src/workers/processors/__tests__/
```

Fix any tests that depended on the polling drain timer.

- [ ] **Step 4: Commit**

```bash
git add src/workers/processors/agent-run.ts \
        # plus any helper files split out
git commit -m "refactor(agent-run): yield-on-wait state machine; no polling drain"
```

---

### Task D4: Update teammate completion to re-enqueue parent

**Files:**
- Modify: `src/workers/processors/lib/synthesize-notification.ts` (or wherever `synthAndDeliverNotification` lives)
- Create: `src/workers/processors/lib/__tests__/parent-reenqueue.test.ts`

**Rationale:** Currently teammate completion does `wake(parentAgentId)`. Now we additionally need to (a) remove the completing child's id from the parent's `waiting_for` array (atomic UPDATE with `array_remove`), and (b) if `cardinality(waiting_for) = 0` post-update, transition parent status `waiting_for_children → running` and wake. This must be atomic so two simultaneous completions don't both think they're the last and double-wake.

- [ ] **Step 1: Write the failing test**

```ts
// src/workers/processors/lib/__tests__/parent-reenqueue.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import { agentRuns } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { removeChildAndMaybeWake } from '../parent-reenqueue';

describe('removeChildAndMaybeWake', () => {
  beforeEach(async () => {
    // seed a parent with waiting_for = ['c1', 'c2']
    await db.insert(agentRuns).values({
      id: 'p1',
      teamId: 'test-team',
      memberId: 'test-member',
      agentDefName: 'lead',
      status: 'waiting_for_children',
      waitingFor: ['c1', 'c2'],
    });
  });

  it('removes child, keeps waiting when array non-empty', async () => {
    await removeChildAndMaybeWake('p1', 'c1');
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, 'p1'));
    expect(row.waitingFor).toEqual(['c2']);
    expect(row.status).toBe('waiting_for_children');
  });

  it('removes last child, transitions to running and signals wake', async () => {
    await removeChildAndMaybeWake('p1', 'c1');
    const shouldWake = await removeChildAndMaybeWake('p1', 'c2');
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, 'p1'));
    expect(row.waitingFor).toEqual([]);
    expect(row.status).toBe('running');
    expect(shouldWake).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/workers/processors/lib/parent-reenqueue.ts
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns } from '@/lib/db/schema';

/**
 * Atomically removes `childId` from parent's waiting_for array.
 * If the resulting array is empty, transitions parent from
 * 'waiting_for_children' → 'running' and returns true (caller should wake()).
 */
export async function removeChildAndMaybeWake(
  parentAgentId: string,
  childAgentId: string,
): Promise<boolean> {
  // Single UPDATE…RETURNING does the atomic read-modify-write
  const rows = await db.execute(sql`
    UPDATE agent_runs
    SET
      waiting_for = array_remove(waiting_for, ${childAgentId}),
      status = CASE
        WHEN cardinality(array_remove(waiting_for, ${childAgentId})) = 0
          AND status = 'waiting_for_children'
        THEN 'running'
        ELSE status
      END,
      last_active_at = NOW()
    WHERE id = ${parentAgentId}
    RETURNING cardinality(waiting_for) AS remaining, status
  `);
  const row = (rows as unknown as { remaining: number; status: string }[])[0];
  return row?.remaining === 0 && row.status === 'running';
}
```

- [ ] **Step 3: Hook into synthAndDeliverNotification**

```ts
// In src/workers/processors/lib/synthesize-notification.ts
import { removeChildAndMaybeWake } from './parent-reenqueue';
import { wake } from './wake';

// In synthAndDeliverNotification (after inserting the task_notification row):
if (parentAgentId) {
  const shouldWake = await removeChildAndMaybeWake(parentAgentId, childAgentId);
  if (shouldWake) {
    await wake(parentAgentId, 'priority'); // 'priority' lane — founder-facing
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
bun run test src/workers/processors/lib/__tests__/parent-reenqueue.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/workers/processors/lib/parent-reenqueue.ts \
        src/workers/processors/lib/__tests__/parent-reenqueue.test.ts \
        src/workers/processors/lib/synthesize-notification.ts
git commit -m "feat(team): atomic parent-reenqueue on last child completion"
```

---

### Task D5: Update peer-DM shadow (preserve no-wake semantics)

**Files:**
- Modify: `src/workers/processors/lib/peer-dm-shadow.ts`

**Rationale:** Per CLAUDE.md invariant: peer-DM shadow MUST NOT call wake(). With D3, the lead no longer polls — it only acts on natural wakes (founder message, child completion, sleep expiry). This means peer-DM visibility is delayed until the next natural wake, which is INTENDED. Verify no regression in the existing shadow code and add a regression test.

- [ ] **Step 1: Audit peer-dm-shadow.ts**

```bash
grep -n "wake\|enqueue\|reenqueue" /Users/yifeng/Documents/Code/shipflare/src/workers/processors/lib/peer-dm-shadow.ts
```

Expected: no occurrences. If there ARE wake() calls, remove them (they would have violated the invariant before D3 too, but D3 makes the violation user-visible: each peer-DM would burn a full lead-step LLM call).

- [ ] **Step 2: Add a regression test**

```ts
// src/workers/processors/lib/__tests__/peer-dm-shadow-no-wake.test.ts
import { describe, it, expect, vi } from 'vitest';
import { insertPeerDmShadow } from '../peer-dm-shadow';
import * as wakeModule from '../wake';

describe('insertPeerDmShadow', () => {
  it('does NOT call wake() on the lead', async () => {
    const wakeSpy = vi.spyOn(wakeModule, 'wake');
    await insertPeerDmShadow({
      leadAgentId: 'lead-1',
      fromAgentId: 'member-1',
      toAgentId: 'member-2',
      content: 'sup',
    });
    expect(wakeSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
bun run test src/workers/processors/lib/__tests__/peer-dm-shadow-no-wake.test.ts
git add src/workers/processors/lib/__tests__/peer-dm-shadow-no-wake.test.ts \
        src/workers/processors/lib/peer-dm-shadow.ts
git commit -m "test(team): regression — peer-DM shadow never wakes lead"
```

---

### Task D6: Backfill existing in-flight runs

**Files:**
- Create: `scripts/backfill-agent-runs-checkpoint.ts`

**Rationale:** Before deploy, any `agent_runs` row currently in `status='running'` or `'sleeping'` has no `checkpoint` and no `waiting_for`. The simplest backfill is to mark them `status='failed'` with `shutdown_reason='migration_to_durable_lead'` — they were going to die on the next worker restart anyway when their lockDuration expired without a checkpoint. Document this loudly. Production deploy must be done during a low-traffic window.

- [ ] **Step 1: Backfill script**

```ts
// scripts/backfill-agent-runs-checkpoint.ts
#!/usr/bin/env bun
import { db } from '@/lib/db';
import { agentRuns } from '@/lib/db/schema';
import { inArray } from 'drizzle-orm';

async function main() {
  const result = await db
    .update(agentRuns)
    .set({
      status: 'failed',
      shutdownReason: 'migration_to_durable_lead_2026_05',
    })
    .where(inArray(agentRuns.status, ['running', 'sleeping', 'resuming']))
    .returning({ id: agentRuns.id });
  console.log(`Marked ${result.length} in-flight runs as failed for migration.`);
}
main().then(() => process.exit(0));
```

- [ ] **Step 2: Deploy runbook**

Document in `docs/deploy-durable-lead.md`:
1. Schedule a maintenance window
2. Pause BullMQ workers via the orchestrator
3. Deploy DB migration (D1)
4. Run backfill (this script)
5. Deploy new worker code (D2-D5)
6. Resume workers
7. Verify metrics endpoint shows healthy queue depths within 5 min

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-agent-runs-checkpoint.ts docs/deploy-durable-lead.md
git commit -m "deploy(team): backfill script + runbook for durable-lead migration"
```

---

### Task D7: Multi-user durability smoke test

**Files:**
- Create: `e2e/tests/durable-lead.spec.ts`

**Rationale:** The whole point of D is "many leads, few worker slots." Test that.

- [ ] **Step 1: Write the test**

```ts
// e2e/tests/durable-lead.spec.ts
import { test, expect, type BrowserContext } from '@playwright/test';

test('20 simultaneous leads do not deadlock at concurrency 6', async ({ browser }) => {
  // Seed 20 users (assumes already exist) — auth state files user-{i}.json
  const userCount = 20;
  const contexts: BrowserContext[] = [];
  for (let i = 0; i < userCount; i++) {
    contexts.push(
      await browser.newContext({ storageState: `e2e/auth/user-${i}.json` }),
    );
  }

  // Each user fires a fan-out message simultaneously
  const sends = contexts.map(async (ctx, i) => {
    const page = await ctx.newPage();
    await page.goto('http://localhost:3000/team');
    await page.getByPlaceholder(/Message your team/i).fill(`User ${i}: find me threads`);
    return page.keyboard.press('Enter');
  });
  await Promise.all(sends);

  // Within 60s, every user should see at least their lead's first response.
  const checks = contexts.map(async (ctx) => {
    const page = ctx.pages()[0]!;
    return expect(page.locator('[data-role="lead-message"]').first()).toBeVisible({
      timeout: 60_000,
    });
  });
  await Promise.all(checks);
});
```

- [ ] **Step 2: Commit**

```bash
git add e2e/tests/durable-lead.spec.ts
git commit -m "test(e2e): 20-user durable-lead concurrency smoke"
```

---

## Cross-Cutting: Rollback Plan

Each phase ships behind a feature env flag so it can be disabled fast without redeploy:

| Phase | Env flag | Off behavior |
|---|---|---|
| A | `NEXT_PUBLIC_USE_VIRTUAL_CONVERSATION=false` | Skip virtualization (Task A3) |
| B | `ENABLE_TENANT_SEMAPHORE=false` | Skip acquire in agent-run (Task B3) |
| B | `ENABLE_LLM_TOKEN_BUCKET=false` | Skip bucket in createMessage (Task B5) |
| D | `ENABLE_DURABLE_LEAD=false` | processAgentRun uses the legacy polling-drain body (kept around for one release) |

Implementation note for D: in Task D3, keep the old `runAgentTurn` body in a sibling function `runAgentTurn_legacy` and switch on the env flag. After 2 weeks of clean prod metrics, delete the legacy path.

---

## Self-Review

**Spec coverage:**
- Phase A — 4 tasks: streaming context (A1), bottom rail (A2), virtualization (A3), e2e smoke (A4). All four research items from the engine/ report addressed: sticky scroll (existing useAutoScroll preserved), bottom subagent panel (A2), streaming via reducer/ref (A1), virtualization (A3). History pagination and task hierarchy were "use existing" in the report — no new task needed.
- Phase B — 8 tasks: pool bump+cache audit (B1), Lua semaphore (B2), wire-in (B3), token bucket Lua (B4), wire-in (B5), priority lanes (B6), heartbeat batching (B7), e2e smoke (B8). Maps to root causes A (pool), B (LLM API ceiling), and the noisy-neighbor fairness research.
- Phase D — 7 tasks: migration (D1), pure step fn (D2), processor refactor (D3), parent-reenqueue (D4), peer-DM regression (D5), backfill (D6), e2e smoke (D7). Maps to the "yield-on-wait" DIY pattern recommended in §8 of the durable-execution research.

**Placeholder scan:** Task D2 step 2 has a literal "TODO: port body from agent-run.ts runAgentTurn" — this is a deliberate hand-off because the body is ~800 lines of existing code that should be lifted in place, not rewritten from scratch in this plan. Acceptable: the engineer knows the source file and the target shape. All other steps include complete code blocks.

**Type consistency:** `LeadCheckpoint` defined in D1 + used in D2/D3 — names match. `AgentRunPriority` defined in B6, used in updated `wake()` signature — match. `LlmRateLimitedError` defined in B5, caught in B5 step 5 — match. `acquireTenantSlot` / `releaseTenantSlot` signatures match between B2 and B3 callers.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-multi-tenant-stability.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because each task is self-contained and the dispatched subagent can be told "implement Task B3" without needing the whole 3-phase context.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best if you want to see every diff inline.

Either way, recommended order:
- Phase A and Phase B can run in parallel (no shared files)
- Phase D requires B's Lua bucket + priority lanes to be live (Task B5 + B6)

Which approach?
