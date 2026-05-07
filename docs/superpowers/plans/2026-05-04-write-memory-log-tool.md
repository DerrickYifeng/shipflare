# write_memory_log Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent a `write_memory_log` tool — a thin wrapper over the already-existing `MemoryStore.appendLog()` so agents can record one-line learnings ("@founderhandle's reply got 3x avg engagement", "compete-vs-x angle landed flat") that the existing nightly distill pass folds into formal `agent_memories` entries. Closes Tier-1 gap #2 from the agent-team gap roadmap.

**Architecture:**
1. **One new tool: `write_memory_log({entry: string})`.** Calls `MemoryStore.appendLog(entry)` and returns `{logged: true}`. Idempotent on `(productId, entry, sameMinute)` — duplicate logs in the same minute are silently coalesced (the distill pass already dedupes).
2. **Both shipped agents get it.** Coordinator logs cross-channel observations; social-media-manager logs voice/engagement learnings.
3. **Distill pipeline already exists.** `MemoryStore.getProductsWithUndistilledLogs()` + `markLogsDistilled()` are used by an existing BullMQ cron (verify under `src/workers/`). No new processor needed — this plan only adds the WRITE side.
4. **Engine alignment.** Mirrors `engine/tools/AgentTool/agentMemory.ts` shape but scoped per-`(userId, productId)` rather than per-`agentDefName` (intentional — see roadmap row #8 for why).

**Tech Stack:**
- Zod for tool input validation
- Drizzle (no schema change — `agent_memory_logs` table exists per [`src/lib/db/schema/memories.ts:54`](../../src/lib/db/schema/memories.ts#L54))
- Vitest unit tests

**Depends on:**
- `2026-05-03-merge-judging-and-share-slop-rules.md` (Plan 1)
- `2026-05-04-pipeline-to-tools.md` (Plan 2)
- `2026-05-04-collapse-to-social-media-manager.md` (Plan 3)

---

## File map

**Created**
- `src/tools/WriteMemoryLogTool/WriteMemoryLogTool.ts`
- `src/tools/WriteMemoryLogTool/__tests__/WriteMemoryLogTool.test.ts`

**Modified**
- `src/tools/registry.ts` (register `writeMemoryLogTool`)
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (add `write_memory_log` to tools)
- `src/tools/AgentTool/agents/social-media-manager/AGENT.md` (add `write_memory_log` to tools, add 1 pattern)
- `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md` (one new pattern: log-then-finish)

**Deleted**
- (none)

---

## Task 1: Verify the distill pipeline exists (read-only check, no code change)

**Files:** none — verification only.

The plan assumes a BullMQ processor calls `MemoryStore.getProductsWithUndistilledLogs()` + does the LLM distill pass. If it doesn't, this plan still ships value (`appendLog` rows are durable; founder can read them in DB), but learnings won't surface in `<agent-memory>` injection until the consumer ships.

- [ ] **Step 1: Find the distill consumer**

```bash
grep -rn "getProductsWithUndistilledLogs\|markLogsDistilled" src/workers/ src/lib/ src/app/ 2>&1 | head -10
```

Expected: 1+ hits — likely a worker like `src/workers/processors/distill-memory.ts` or similar.

- [ ] **Step 2: Document what you found in the implementation log**

If a consumer exists, note its path in your final commit message ("write side complements existing distiller at `src/workers/processors/X.ts`").
If NOT, add a follow-up note in the final commit ("write side ships; distiller TBD — logs accumulate in `agent_memory_logs` until a consumer is built").

No file changes in this task.

---

## Task 2: Implement the tool (TDD)

**Files:**
- Create: `src/tools/WriteMemoryLogTool/WriteMemoryLogTool.ts`
- Test: `src/tools/WriteMemoryLogTool/__tests__/WriteMemoryLogTool.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/tools/WriteMemoryLogTool/__tests__/WriteMemoryLogTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { agentMemoryLogs, products, users } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import {
  writeMemoryLogTool,
  WRITE_MEMORY_LOG_TOOL_NAME,
  writeMemoryLogInputSchema,
} from '../WriteMemoryLogTool';

describe('write_memory_log tool — schema', () => {
  it('rejects empty entry', () => {
    const r = writeMemoryLogInputSchema.safeParse({ entry: '' });
    expect(r.success).toBe(false);
  });

  it('rejects entry over 500 chars', () => {
    const r = writeMemoryLogInputSchema.safeParse({ entry: 'a'.repeat(501) });
    expect(r.success).toBe(false);
  });

  it('accepts a typical one-line learning', () => {
    const r = writeMemoryLogInputSchema.safeParse({
      entry: '@founderhandle reply on launch thread got 3x avg engagement',
    });
    expect(r.success).toBe(true);
  });

  it('rejects multi-line entries (should be one observation per call)', () => {
    const r = writeMemoryLogInputSchema.safeParse({
      entry: 'line one\nline two',
    });
    expect(r.success).toBe(false);
  });
});

describe('write_memory_log tool — execute', () => {
  let userId: string;
  let productId: string;

  beforeEach(async () => {
    userId = crypto.randomUUID();
    productId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, email: `${userId}@test.local` });
    await db.insert(products).values({
      id: productId,
      userId,
      name: 'Test Product',
      description: 'd',
    });
  });

  it('inserts a row in agent_memory_logs scoped to (userId, productId)', async () => {
    const ctx = makeMockToolContext({ userId, productId });
    const result = await writeMemoryLogTool.execute(
      { entry: 'voice rule: avoid superlatives' },
      ctx,
    );
    expect(result.logged).toBe(true);

    const rows = await db
      .select()
      .from(agentMemoryLogs)
      .where(eq(agentMemoryLogs.productId, productId));
    expect(rows.length).toBe(1);
    expect(rows[0].entry).toBe('voice rule: avoid superlatives');
    expect(rows[0].distilled).toBe(false);
  });

  it('coalesces duplicate entries within the same minute (idempotent)', async () => {
    const ctx = makeMockToolContext({ userId, productId });
    await writeMemoryLogTool.execute(
      { entry: 'humble voice landed for outage threads' },
      ctx,
    );
    await writeMemoryLogTool.execute(
      { entry: 'humble voice landed for outage threads' },
      ctx,
    );
    const rows = await db
      .select()
      .from(agentMemoryLogs)
      .where(eq(agentMemoryLogs.productId, productId));
    expect(rows.length).toBe(1);
  });

  it('inserts a second row when entry differs even within the same minute', async () => {
    const ctx = makeMockToolContext({ userId, productId });
    await writeMemoryLogTool.execute({ entry: 'first observation' }, ctx);
    await writeMemoryLogTool.execute({ entry: 'second observation' }, ctx);
    const rows = await db
      .select()
      .from(agentMemoryLogs)
      .where(eq(agentMemoryLogs.productId, productId));
    expect(rows.length).toBe(2);
  });

  it('throws when ctx lacks userId or productId', async () => {
    const ctx = makeMockToolContext({ userId: null, productId });
    await expect(
      writeMemoryLogTool.execute({ entry: 'x' }, ctx),
    ).rejects.toThrow();
  });
});

function makeMockToolContext(values: {
  userId: string | null;
  productId: string | null;
}) {
  const map = new Map<string, unknown>();
  if (values.userId) map.set('userId', values.userId);
  if (values.productId) map.set('productId', values.productId);
  return {
    get<T>(k: string): T {
      if (!map.has(k)) throw new Error(`ctx key not set: ${k}`);
      return map.get(k) as T;
    },
  } as unknown as Parameters<typeof writeMemoryLogTool.execute>[1];
}
```

- [ ] **Step 2: Run tests, verify FAIL**

```bash
pnpm vitest run src/tools/WriteMemoryLogTool/__tests__/WriteMemoryLogTool.test.ts
```

Expected: failures (tool doesn't exist).

- [ ] **Step 3: Implement the tool**

Create `src/tools/WriteMemoryLogTool/WriteMemoryLogTool.ts`:

```typescript
// write_memory_log — append a one-line observation to agent_memory_logs.
// The existing nightly distill pass folds these into formal agent_memories
// entries (see MemoryStore.getProductsWithUndistilledLogs / markLogsDistilled).
//
// Scope: (userId, productId) — shared across all agents on the same product
// so coordinator's observations and social-media-manager's observations
// build into one knowledge base. (Engine's per-agentDefName scoping was
// rejected; see docs/agent-team-gap-roadmap.md row #8 for rationale.)
//
// Idempotency: same (productId, entry) within the same minute is
// silently coalesced — agents that loop and re-log the same observation
// each turn don't pollute the log.

import { z } from 'zod';
import { and, eq, gte } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { readDomainDeps } from '@/tools/context-helpers';
import { db } from '@/lib/db';
import { agentMemoryLogs } from '@/lib/db/schema';
import { MemoryStore } from '@/memory/store';
import { createLogger } from '@/lib/logger';

const log = createLogger('tools:write_memory_log');

export const WRITE_MEMORY_LOG_TOOL_NAME = 'write_memory_log';

export const writeMemoryLogInputSchema = z
  .object({
    entry: z
      .string()
      .min(1, 'entry is required')
      .max(500, 'entry must be 500 characters or fewer')
      .refine((s) => !s.includes('\n'), {
        message:
          'entry must be a single line — log one observation per call. Make multiple calls for multiple observations.',
      }),
  })
  .strict();

export type WriteMemoryLogInput = z.infer<typeof writeMemoryLogInputSchema>;

export interface WriteMemoryLogResult {
  logged: true;
}

/**
 * Returns true if (productId, entry) was logged within the last 60s.
 * Used to coalesce duplicate logs from agents that loop without
 * recognizing they've already recorded the same observation this turn.
 */
async function isDuplicateWithinMinute(
  productId: string,
  entry: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 60_000);
  const rows = await db
    .select({ id: agentMemoryLogs.id })
    .from(agentMemoryLogs)
    .where(
      and(
        eq(agentMemoryLogs.productId, productId),
        eq(agentMemoryLogs.entry, entry),
        gte(agentMemoryLogs.loggedAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export const writeMemoryLogTool: ToolDefinition<
  WriteMemoryLogInput,
  WriteMemoryLogResult
> = buildTool({
  name: WRITE_MEMORY_LOG_TOOL_NAME,
  description:
    'Record a one-line observation about the product or its audience that you ' +
    'want future runs to remember. Format: a single declarative sentence ' +
    '(max 500 chars). Examples: "@founderhandle\'s outage threads land best ' +
    'with humble voice"; "competitor X comparison angle got 3x avg engagement"; ' +
    '"avoid superlatives in launch posts — fell flat 2x in a row". The entry ' +
    'is appended to agent_memory_logs and folded into <agent-memory> on the ' +
    'next nightly distill pass. Same entry within the same minute is silently ' +
    'coalesced — log one observation per call, multiple calls for multiple ' +
    'observations.',
  inputSchema: writeMemoryLogInputSchema,
  // Concurrency-safe: distinct entries inside the same turn write distinct
  // rows; identical entries collapse via the duplicate check.
  isConcurrencySafe: true,
  isReadOnly: false,
  async execute(input, ctx): Promise<WriteMemoryLogResult> {
    const { userId, productId } = readDomainDeps(ctx);

    if (await isDuplicateWithinMinute(productId, input.entry)) {
      log.debug(
        `write_memory_log: coalesced duplicate "${input.entry}" for product ${productId}`,
      );
      return { logged: true };
    }

    const store = new MemoryStore(userId, productId);
    await store.appendLog(input.entry);
    return { logged: true };
  },
});
```

- [ ] **Step 4: Run tests, verify all PASS**

```bash
pnpm vitest run src/tools/WriteMemoryLogTool/__tests__/WriteMemoryLogTool.test.ts
```

Expected: 8/8 pass.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/WriteMemoryLogTool/
git commit -m "feat(tools): add write_memory_log — agent-side learning capture"
```

---

## Task 3: Register the tool

**Files:**
- Modify: `src/tools/registry.ts`

- [ ] **Step 1: Find where read_memory is registered and mirror it**

```bash
grep -n "readMemoryTool" src/tools/registry.ts
```

Expected: 2 hits (import + registration).

- [ ] **Step 2: Add the import + registration**

After `import { readMemoryTool } from './ReadMemoryTool/ReadMemoryTool';` add:

```typescript
import { writeMemoryLogTool } from './WriteMemoryLogTool/WriteMemoryLogTool';
```

In the same registration object that includes `readMemoryTool`, add `writeMemoryLogTool` directly below it.

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 4: Smoke check**

```bash
pnpm tsx -e "
  import('./src/tools/registry.js').then(({ getRegisteredTool }) => {
    const t = getRegisteredTool('write_memory_log');
    console.log(t ? 'OK' : 'FAIL: write_memory_log not registered');
  });
"
```

Expected: `OK`. (Substitute the actual export name if `getRegisteredTool` differs.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.ts
git commit -m "feat(tools): register write_memory_log in tool registry"
```

---

## Task 4: Add to both agents

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`
- Modify: `src/tools/AgentTool/agents/social-media-manager/AGENT.md`
- Modify: `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`

- [ ] **Step 1: Add tool to coordinator's frontmatter**

Open `src/tools/AgentTool/agents/coordinator/AGENT.md`. The `tools:` list (post-AskUserQuestion plan) includes `read_memory` already (verify with grep; if not, this plan adds it for the coordinator AND adds write_memory_log). Add `write_memory_log` directly after `read_memory`:

```yaml
tools:
  - Task
  - SendMessage
  - AskUserQuestion
  - read_memory
  - write_memory_log
  - query_team_status
  ...
```

If `read_memory` isn't in the coordinator's list, add it first — coordinator should know what social-media-manager has been logging.

- [ ] **Step 2: Add tool to social-media-manager's frontmatter**

Open `src/tools/AgentTool/agents/social-media-manager/AGENT.md`. Per Plan 3 the list already includes `read_memory`. Add `write_memory_log` after it:

```yaml
tools:
  - find_threads_via_xai
  - find_threads
  - process_replies_batch
  - process_posts_batch
  - query_plan_items
  - query_product_context
  - read_memory
  - write_memory_log
  - SendMessage
  - AskUserQuestion
  - StructuredOutput
```

- [ ] **Step 3: Add a pattern to social-media-manager's patterns-and-examples**

Open `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`. Append:

```markdown
### Pattern: log-then-finish (capture a learning before ending the turn)

You noticed something worth remembering — a voice that landed, an account
that consistently engages, an angle that fell flat. Don't lose it; log it
before you summarize.

You: process_replies_batch({ threadIds: ['t1', 't2', 't3'] })
  → { draftsCreated: 3, draftsSkipped: 0, notes: 'all humble-voice variants' }

You: write_memory_log({ entry: 'humble voice variants pass validating-draft cleanly for outage threads (3/3 today)' })
  → { logged: true }

You (StructuredOutput): Drafted 3 humble-voice replies for outage threads; logged the pattern for next time.

When NOT to log:
- Routine state ("drafted 3 posts") — already in StructuredOutput.notes.
- Speculation without a signal — only log what you observed.
- Same observation you already logged this turn — the tool coalesces but
  it's noise; check first.
```

- [ ] **Step 4: Run loader tests**

```bash
pnpm vitest run src/tools/AgentTool/agents/coordinator/ src/tools/AgentTool/agents/social-media-manager/
```

If existing tests assert exact tool count, update them. The new tool is `write_memory_log`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/AGENT.md \
        src/tools/AgentTool/agents/social-media-manager/
git commit -m "feat(agents): teach coordinator + social-media-manager to call write_memory_log"
```

---

## Task 5: Final verification + push

- [ ] **Step 1: Greppable invariants**

```bash
# Tool registered
grep -c "writeMemoryLogTool" src/tools/registry.ts
# Expected: 2 (import + registration)

# Both agents reference the tool
grep -l "write_memory_log" src/tools/AgentTool/agents/*/AGENT.md
# Expected: coordinator/AGENT.md, social-media-manager/AGENT.md

# Tool dir exists with test
ls src/tools/WriteMemoryLogTool/
# Expected: WriteMemoryLogTool.ts, __tests__/

# read_memory still works (no regression)
grep -c "readMemoryTool" src/tools/registry.ts
# Expected: 2
```

- [ ] **Step 2: Type-check + tests**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

Expected: 0 errors, 0 failures.

- [ ] **Step 3: Push**

```bash
git push -u origin HEAD
```

---

## Self-Review

**Spec coverage:**
- Verify distill consumer exists → Task 1 ✓
- Tool with input schema + duplicate-coalesce → Task 2 ✓
- Tool registered → Task 3 ✓
- Both agents teach the tool → Task 4 ✓
- Final greppable check → Task 5 ✓

**Placeholder scan:** No "TBD" / "implement later" anywhere. Every code step shows the actual code.

**Type consistency:**
- `WriteMemoryLogInput.entry: string` matches `MemoryStore.appendLog(entry: string)` signature.
- `(userId, productId)` scoping matches `read_memory`'s scoping (both via `readDomainDeps`), keeping the read/write pair symmetric.

---

## Tradeoffs / risks

- **Coalesce window is 60s, hard-coded.** If two agents log the same observation 61s apart, they get two rows. Acceptable — the distill pass dedupes with semantic similarity. Don't engineer a configurable window.
- **No throttle per agent.** A misbehaving agent could log 100 entries per turn. Mitigation: zod `max(500)` per entry caps row size; the coalesce kills exact dupes. If real-world agents abuse this, add a per-agent-run row count cap in the tool's execute (read `agent_runs.id` from ctx, count rows logged this run, cap at e.g. 20).
- **Distill pipeline assumed to exist.** Task 1 documents the assumption. If it doesn't, this plan still ships value (durable log table) but learnings won't surface in `<agent-memory>` until a consumer is built. Follow-up plan: "agent-memory distill processor" — small (~100 lines, 1 BullMQ job + 1 LLM call per product per night).
- **Shared scope rather than per-agent.** Coordinator's observations show up in social-media-manager's `<agent-memory>` and vice-versa. Intentional — cross-agent product knowledge is the point. If we ever need agent-specific learnings (e.g. "social-media-manager's voice tuning"), add a `scope: 'shared' | 'self'` field then; do NOT default to per-agent.
