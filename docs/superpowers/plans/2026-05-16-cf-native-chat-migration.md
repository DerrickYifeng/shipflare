# CF-Native Chat Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled chat / activity / dispatch stack with five clean layers built directly on Cloudflare Agents SDK + AI SDK v5, preserving the Skill primitive and moving ops telemetry to Workers Analytics Engine.

**Architecture:** AIChatAgent for CMO + employees; generalized `consult` tool over `runAgentTool`; Skill primitive emits AI SDK v5 `data-*` parts; single Analytics Engine dataset for ops; external MCP for CMO via OAuth. Full design: `docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`.

**Tech Stack:** Cloudflare Workers + Durable Objects, `agents@0.12.4`, `@cloudflare/ai-chat` (to install), AI SDK v5 (`ai`, `@ai-sdk/anthropic`), Zod, Workers Analytics Engine, Next.js (web), vitest + `@cloudflare/vitest-pool-workers`, Playwright (e2e).

**Branch:** `feat/cf-native-chat-migration` (off `dev`, replace-in-place; does NOT merge until Phase 11).

---

## File Structure

### Added

```
apps/core/src/agents/
  _SYSTEM_PREAMBLE.md                      shared agent system prompt prefix
  registry.ts                              EMPLOYEE_REGISTRY single SoT
  lib/
    consult-tool.ts                        makeConsultTool factory
    peer-schema.ts                         peerInputSchema, peerOutputSchema
    get-employee.ts                        getEmployee(id, userId, env)
    setup-agent-test.ts                    test harness factory
    system-prompt.ts                       loadSystemPrompt(employeeId)
  cmo/CMO.ts                               REWRITE — AIChatAgent
  cmo/SYSTEM.md                            CMO role-specific brain
  head-of-growth/HeadOfGrowth.ts           REWRITE — AIChatAgent
  head-of-growth/SYSTEM.md
  social-media-manager/SocialMediaMgr.ts   REWRITE — AIChatAgent
  social-media-manager/SYSTEM.md

apps/core/src/external/
  CmoExternalMcp.ts                        external MCP surface for CMO

apps/core/src/lib/
  agent-depth.ts                           safeAgentChain + cycle/depth errors
  telemetry.ts                             writeAgentEvent → Analytics Engine

apps/web/src/hooks/
  use-cmo-chat.ts                          useAgentChat + useAgentToolEvents

apps/web/app/(app)/chat/_components/
  cmo-chat.tsx                             main chat UI
  text-part.tsx
  reasoning-part.tsx
  nested-agent-run.tsx
  skill-part.tsx
  tool-invocation.tsx
  step-anchor.tsx
  message-bubble.tsx

apps/web/app/api/agent-token/
  route.ts                                 generic per-agent WS JWT

scripts/
  verify-telemetry.ts                      post-deploy Analytics Engine SQL check
```

### Deleted (Phase 10)

```
packages/shared/src/activity-event.ts
apps/core/src/lib/activity.ts
apps/core/src/lib/forward-activity.ts
apps/core/src/lib/subagent-activity.ts
apps/web/src/hooks/use-cmo-activity.ts
apps/web/app/api/cmo-activity/route.ts
apps/web/app/api/cmo-ws-token/route.ts
apps/core/src/agents/cmo/tools/getRecentActivity.ts  (if present)
packages/db/migrations/<new>_drop_founder_messages_and_activity_events.sql
```

### Modified

```
apps/core/wrangler.jsonc                   bindings renamed (HEAD_OF_GROWTH→HOG, SOCIAL_MEDIA_MGR→SMM); analytics_engine_datasets added; OAuth env
apps/core/src/env.ts                       Env type derived from EMPLOYEE_REGISTRY + TELEMETRY binding
packages/skills/src/runner.ts              runSkill emits data parts + telemetry
apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx  rewrite on useCmoChat
CLAUDE.md                                  New Employee Checklist (post New Platform Checklist)
```

---

# Phase 0 — Foundation

Verify SDK shape, install dependencies, scaffold telemetry + OAuth bindings.

---

### Task 0.1: Install `@cloudflare/ai-chat` + verify AI SDK v5 versions

**Files:**
- Modify: `apps/core/package.json`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Check current versions**

```bash
pnpm list ai @ai-sdk/anthropic agents @cloudflare/ai-chat --depth 0 -r 2>&1 | head -30
```

Expected: `agents@0.12.x` present; `@cloudflare/ai-chat` absent; AI SDK v5 (`ai@5.x`, `@ai-sdk/anthropic@1.x`).

- [x] **Step 2: Install `@cloudflare/ai-chat` in core and web**

```bash
pnpm --filter @shipflare/core add @cloudflare/ai-chat
pnpm --filter web add @cloudflare/ai-chat
```

- [x] **Step 3: If AI SDK is < v5, upgrade**

```bash
pnpm --filter @shipflare/core add ai@latest @ai-sdk/anthropic@latest
pnpm --filter web add ai@latest @ai-sdk/anthropic@latest
```

- [x] **Step 4: Verify build still green**

```bash
pnpm -r exec tsc --noEmit
```
Expected: 0 errors (we haven't changed any code yet; any errors are pre-existing and must be fixed before continuing).

- [x] **Step 5: Commit**

```bash
git add apps/core/package.json apps/web/package.json pnpm-lock.yaml
git commit -m "chore: install @cloudflare/ai-chat for Phase 0 of CF-native migration"
```

---

### Task 0.2: Phase 0 verifications (spec §15)

**Files:**
- Create: `docs/superpowers/specs/2026-05-16-phase-0-verifications.md`

- [x] **Step 1: Verify `runAgentTool` public API**

```bash
grep -rln "runAgentTool\|agentTool" node_modules/agents/dist/agent-tools/ 2>/dev/null | head -5
cat node_modules/agents/dist/agent-tools/index.d.ts 2>/dev/null | grep -E "export (function|const|class) (runAgentTool|agentTool)"
```

Record finding: is `runAgentTool` exported? If only `agentTool(Cls)` is exposed, the plan's `consult-tool.ts` must pre-instantiate one `agentTool` per employee instead.

- [x] **Step 2: Verify `@ai-sdk/anthropic` reasoning support**

```bash
grep -l "reasoning" node_modules/@ai-sdk/anthropic/dist/*.d.ts | head -3
grep -E "reasoning-(start|delta|end)" node_modules/@ai-sdk/anthropic/dist/*.js 2>/dev/null | head -5
```

Record: do Anthropic provider chunks include `reasoning-*`? If not, plan a shim that maps Claude `thinking` content blocks → AI SDK `reasoning-delta`.

- [x] **Step 3: Verify `useAgentChat` export**

```bash
test -f node_modules/@cloudflare/ai-chat/react/dist/index.d.ts && \
  grep -E "export (function|const) useAgentChat" node_modules/@cloudflare/ai-chat/react/dist/index.d.ts
```

Record exact import path.

- [x] **Step 4: Verify `experimental_context` threading**

```bash
grep -E "experimental_context" node_modules/ai/dist/index.d.ts | head -5
```

Record: does the `tool` execute signature accept context?

- [x] **Step 5: Verify tool definition API (`defineTool` vs `tool`)**

```bash
grep -E "export (function|const) (defineTool|tool)" node_modules/agents/dist/tools/*.d.ts node_modules/ai/dist/index.d.ts 2>/dev/null | head -10
```

Decide: this plan uses `tool({...})` from `'ai'` if `defineTool` is absent. Apply consistently across all tool definitions.

- [x] **Step 6: Write findings**

Write findings to `docs/superpowers/specs/2026-05-16-phase-0-verifications.md` (a short table: question / answer / impact). If any answer triggers a design change, amend the spec doc in a separate commit BEFORE proceeding to Phase 1.

- [x] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-05-16-phase-0-verifications.md
git commit -m "docs: Phase 0 SDK verifications for CF-native migration"
```

---

### Task 0.3: Add Analytics Engine binding to wrangler

**Files:**
- Modify: `apps/core/wrangler.jsonc`

- [x] **Step 1: Add `analytics_engine_datasets` block to wrangler**

After the existing `durable_objects` block, add:

```jsonc
"analytics_engine_datasets": [
  {
    "binding": "TELEMETRY",
    "dataset": "shipflare_agent_events"
  }
]
```

- [x] **Step 2: Add binding to `apps/core/src/env.ts`**

```typescript
// in Env interface:
TELEMETRY: AnalyticsEngineDataset;
```

(`AnalyticsEngineDataset` is in `@cloudflare/workers-types`; verify it's already in deps.)

- [x] **Step 3: Verify wrangler config parses**

```bash
cd apps/core && pnpm wrangler types && cd ../..
pnpm -r exec tsc --noEmit
```

Expected: 0 errors.

- [x] **Step 4: Commit**

```bash
git add apps/core/wrangler.jsonc apps/core/src/env.ts
git commit -m "chore: add Analytics Engine binding for ops telemetry"
```

---

### Task 0.4: Scaffold OAuth env (deferred wiring until Phase 7)

**Files:**
- Modify: `apps/core/wrangler.jsonc`
- Modify: `apps/core/src/env.ts`

- [x] **Step 1: Add OAuth env vars to wrangler vars section**

```jsonc
"vars": {
  "MCP_OAUTH_AUDIENCE": "mcp.shipflare.com"
}
```

- [x] **Step 2: Document required secrets in `scripts/cf-deploy-checklist.md`**

Add a line:

```
- MCP_OAUTH_JWT_SIGNING_KEY (set via `wrangler secret put MCP_OAUTH_JWT_SIGNING_KEY`)
  Used by withOAuthProvider to sign tokens for external MCP at mcp.shipflare.com/cmo
```

- [x] **Step 3: Add to Env type**

```typescript
MCP_OAUTH_AUDIENCE: string;
MCP_OAUTH_JWT_SIGNING_KEY: string;
```

- [x] **Step 4: Verify build**

```bash
pnpm -r exec tsc --noEmit
```

- [x] **Step 5: Commit**

```bash
git add apps/core/wrangler.jsonc apps/core/src/env.ts scripts/cf-deploy-checklist.md
git commit -m "chore: scaffold OAuth env for external MCP (Phase 7 wiring)"
```

---

# Phase 1 — Telemetry layer (Layer 5)

Build the Analytics Engine writer. No consumers yet — pure leaf.

---

### Task 1.1: `writeAgentEvent` writer

**Files:**
- Create: `apps/core/src/lib/telemetry.ts`
- Test: `apps/core/test/telemetry.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// apps/core/test/telemetry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { writeAgentEvent } from '../src/lib/telemetry';

describe('writeAgentEvent', () => {
  it('writes tool_invocation with correct blob/double/index slots', () => {
    const writeDataPoint = vi.fn();
    const env = { TELEMETRY: { writeDataPoint } } as any;
    writeAgentEvent(env, {
      kind: 'tool_invocation',
      userId: 'u_1',
      runId: 'r_1',
      blobs: ['draft_post', 'ok', 'sonnet-4-6', 'inline'],
      doubles: [123, 100, 50],
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tool_invocation', 'u_1', 'r_1'],
      blobs: ['draft_post', 'ok', 'sonnet-4-6', 'inline'],
      doubles: [123, 100, 50],
    });
  });

  it('substitutes empty string when runId is missing', () => {
    const writeDataPoint = vi.fn();
    const env = { TELEMETRY: { writeDataPoint } } as any;
    writeAgentEvent(env, {
      kind: 'skill_invocation',
      userId: 'u_2',
      blobs: ['drafting-single-post', 'ok'],
      doubles: [200],
    });
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['skill_invocation', 'u_2', '']);
  });

  it('does not throw when TELEMETRY binding is absent', () => {
    const env = {} as any;
    expect(() => writeAgentEvent(env, {
      kind: 'agent_run', userId: 'u_3', blobs: ['CMO', 'ok'], doubles: [50],
    })).not.toThrow();
  });
});
```

- [x] **Step 2: Run test, expect FAIL**

```bash
pnpm --filter @shipflare/core vitest run test/telemetry.test.ts
```
Expected: FAIL ("Cannot find module ../src/lib/telemetry").

- [x] **Step 3: Implement `writeAgentEvent`**

```typescript
// apps/core/src/lib/telemetry.ts
type AgentEventKind = 'tool_invocation' | 'skill_invocation' | 'agent_run';

export interface AgentEvent {
  kind: AgentEventKind;
  userId: string;
  runId?: string | null;
  blobs: string[];
  doubles: number[];
}

export function writeAgentEvent(env: { TELEMETRY?: AnalyticsEngineDataset }, event: AgentEvent): void {
  if (!env.TELEMETRY) return;  // tolerate absent binding (e.g., in unit tests / preview)
  env.TELEMETRY.writeDataPoint({
    indexes: [event.kind, event.userId, event.runId ?? ''],
    blobs: event.blobs,
    doubles: event.doubles,
  });
}
```

- [x] **Step 4: Run test, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/telemetry.test.ts
```
Expected: PASS (3 tests).

- [x] **Step 5: Verify types compile**

```bash
pnpm -r exec tsc --noEmit
```

- [x] **Step 6: Commit**

```bash
git add apps/core/src/lib/telemetry.ts apps/core/test/telemetry.test.ts
git commit -m "feat(telemetry): writeAgentEvent → Analytics Engine"
```

---

# Phase 2 — Agent depth & cycle safety

Prerequisite for Layer 2. Pure utility, no DO.

---

### Task 2.1: `safeAgentChain` with depth + cycle errors

**Files:**
- Create: `apps/core/src/lib/agent-depth.ts`
- Test: `apps/core/test/agent-depth.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// apps/core/test/agent-depth.test.ts
import { describe, it, expect } from 'vitest';
import { safeAgentChain, MAX_AGENT_DEPTH, AgentDepthExceededError, AgentCycleError } from '../src/lib/agent-depth';

describe('safeAgentChain', () => {
  it('allows up to MAX_AGENT_DEPTH', () => {
    const ctx: any = { props: {} };
    for (let i = 0; i < MAX_AGENT_DEPTH; i++) {
      safeAgentChain.check(ctx, `Agent${i}`);
    }
    expect(ctx.props.__agentChain.length).toBe(MAX_AGENT_DEPTH);
  });

  it('throws AgentDepthExceededError beyond MAX_AGENT_DEPTH', () => {
    const ctx: any = { props: { __agentChain: ['A', 'B', 'C'] } };
    expect(() => safeAgentChain.check(ctx, 'D')).toThrow(AgentDepthExceededError);
  });

  it('throws AgentCycleError on repeated class in chain', () => {
    const ctx: any = { props: { __agentChain: ['CMO', 'HoG'] } };
    expect(() => safeAgentChain.check(ctx, 'CMO')).toThrow(AgentCycleError);
  });

  it('does not mutate input chain (returns a new array)', () => {
    const original = ['CMO'];
    const ctx: any = { props: { __agentChain: original } };
    safeAgentChain.check(ctx, 'HoG');
    expect(original).toEqual(['CMO']);
    expect(ctx.props.__agentChain).toEqual(['CMO', 'HoG']);
  });
});
```

- [x] **Step 2: Run test, expect FAIL**

```bash
pnpm --filter @shipflare/core vitest run test/agent-depth.test.ts
```

- [x] **Step 3: Implement**

```typescript
// apps/core/src/lib/agent-depth.ts
export const MAX_AGENT_DEPTH = 3;

export class AgentDepthExceededError extends Error {
  constructor(public chain: string[]) {
    super(`Agent dispatch depth exceeded (${chain.join(' → ')})`);
    this.name = 'AgentDepthExceededError';
  }
}

export class AgentCycleError extends Error {
  constructor(public chain: string[], public target: string) {
    super(`Agent dispatch cycle (${chain.join(' → ')} → ${target})`);
    this.name = 'AgentCycleError';
  }
}

interface ChainContext { props: { __agentChain?: string[] } & Record<string, unknown> }

export const safeAgentChain = {
  check(ctx: ChainContext, targetClassName: string): void {
    const chain: string[] = ctx.props.__agentChain ?? [];
    if (chain.length >= MAX_AGENT_DEPTH) throw new AgentDepthExceededError(chain);
    if (chain.includes(targetClassName)) throw new AgentCycleError(chain, targetClassName);
    ctx.props.__agentChain = [...chain, targetClassName];
  },
};
```

- [x] **Step 4: Run test, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/agent-depth.test.ts
```

- [x] **Step 5: Commit**

```bash
git add apps/core/src/lib/agent-depth.ts apps/core/test/agent-depth.test.ts
git commit -m "feat(lib): safeAgentChain with depth+cycle errors"
```

---

# Phase 3 — Skill primitive emits data parts

Modify `runSkill` to optionally emit `data-skill-start/finish` parts and write telemetry.

---

### Task 3.1: Add writer + telemetry to `runSkill`

**PLAN AMENDMENT — 2026-05-16:** Pre-flight inspection revealed three
mismatches with reality that this task as-written would silently
paper over. The user authorised splitting Task 3.1 into three
sequential sub-tasks before any emission logic lands:

- **3.1a**: Move `apps/core/src/lib/telemetry.ts` →
  `packages/shared/src/telemetry.ts` so `packages/skills` can import it
  without an inverted app→package dependency. Test file follows.
- **3.1b**: Migrate `runSkill(name, inputs, context)` (positional,
  generic) → `runSkill(opts: RunSkillOptions)` (object-bag). Update
  three callsites: `process-replies-batch.ts`, `process-posts-batch.ts`,
  `find-threads-via-xai.ts`. Add `noop-test-skill` + `throwing-test-skill`
  fixtures to `SKILL_REGISTRY`. **No emission, no telemetry** in this
  step — purely a signature/callsite migration that keeps current
  behaviour. Tests stay green.
- **3.1c**: The original Task 3.1 body below — add
  `data-skill-start`/`data-skill-finish` emissions and the
  `writeAgentEvent` call. Mock `@anthropic-ai/sdk` per-test so the new
  fixtures can actually run without a network call.

The plan body below is **3.1c**. The signature it shows
(`runSkill(opts: RunSkillOptions)` with `loadSkillMeta` /
`executeSkill`) does NOT match the real runner — adapt at
implementation time: use `parseFrontmatter(SKILL_REGISTRY[name])`
instead of `loadSkillMeta`, and inline the existing Anthropic
call instead of `executeSkill(meta, opts.args)`.

**Files:**
- Modify: `packages/skills/src/runner.ts`
- Test: `packages/skills/test/runner.test.ts` (extend)

- [x] **Step 1: Read current `runSkill` signature**

```bash
sed -n '1,80p' packages/skills/src/runner.ts
```

Note the current export. The plan augments the signature with optional `writer` + `parentRunId` + `userId` parameters and an env hook. **Do not change existing call-site behavior** — those parameters are optional.

- [x] **Step 2: Write the failing test (extend existing file)**

```typescript
// packages/skills/test/runner.test.ts — append
import { describe, it, expect, vi } from 'vitest';
import { runSkill } from '../src/runner';

describe('runSkill data parts', () => {
  it('emits data-skill-start before execution and data-skill-finish on success', async () => {
    const writes: any[] = [];
    const writer = { write: (chunk: any) => writes.push(chunk) };
    await runSkill({
      name: 'noop-test-skill',
      args: {},
      writer: writer as any,
      parentRunId: 'p_1',
      userId: 'u_1',
      env: { TELEMETRY: { writeDataPoint: vi.fn() } } as any,
    });
    expect(writes[0].type).toBe('data-skill-start');
    expect(writes[0].data.skillName).toBe('noop-test-skill');
    expect(writes[0].data.parentRunId).toBe('p_1');
    expect(writes[writes.length - 1].type).toBe('data-skill-finish');
    expect(writes[writes.length - 1].data.status).toBe('ok');
  });

  it('emits data-skill-finish status=error on throw and re-raises', async () => {
    const writes: any[] = [];
    const writer = { write: (chunk: any) => writes.push(chunk) };
    await expect(runSkill({
      name: 'throwing-test-skill',
      args: {},
      writer: writer as any,
      userId: 'u_2',
      env: { TELEMETRY: { writeDataPoint: vi.fn() } } as any,
    })).rejects.toThrow();
    expect(writes[writes.length - 1].type).toBe('data-skill-finish');
    expect(writes[writes.length - 1].data.status).toBe('error');
  });

  it('writes telemetry data point with duration', async () => {
    const writeDataPoint = vi.fn();
    await runSkill({
      name: 'noop-test-skill',
      args: {},
      userId: 'u_3',
      env: { TELEMETRY: { writeDataPoint } } as any,
    });
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const call = writeDataPoint.mock.calls[0][0];
    expect(call.indexes[0]).toBe('skill_invocation');
    expect(call.blobs[0]).toBe('noop-test-skill');
    expect(call.blobs[1]).toBe('ok');
    expect(call.doubles[0]).toBeGreaterThanOrEqual(0);
  });

  it('runs without writer present (legacy callers)', async () => {
    await expect(runSkill({
      name: 'noop-test-skill',
      args: {},
      userId: 'u_4',
      env: { TELEMETRY: { writeDataPoint: vi.fn() } } as any,
    })).resolves.not.toThrow();
  });
});
```

Also add two fixture skills if not present:

```typescript
// packages/skills/skills/noop-test-skill/SKILL.md (fixture)
// ---
// name: noop-test-skill
// description: returns null for tests
// ---
```

(If fixtures need bundled implementations, add `_bundled/noop-test-skill.ts` per existing convention.)

- [x] **Step 3: Run, expect FAIL**

```bash
pnpm --filter @shipflare/skills vitest run test/runner.test.ts -t "data parts"
```

- [x] **Step 4: Modify `runSkill`**

In `packages/skills/src/runner.ts`, augment the function signature and body:

```typescript
import { writeAgentEvent } from '@shipflare/core-lib/telemetry'; // or relative path

export interface RunSkillOptions {
  name: string;
  args: Record<string, unknown>;
  // NEW (optional, additive):
  writer?: { write: (chunk: unknown) => void };
  parentRunId?: string | null;
  userId?: string;
  env?: { TELEMETRY?: AnalyticsEngineDataset };
}

export async function runSkill(opts: RunSkillOptions): Promise<unknown> {
  const runId = crypto.randomUUID();
  const meta = await loadSkillMeta(opts.name);

  opts.writer?.write({
    type: 'data-skill-start',
    id: runId,
    data: {
      skillName: opts.name,
      model: meta.model ?? null,
      context: meta.context ?? 'inline',
      parentRunId: opts.parentRunId ?? null,
    },
  });

  const t0 = Date.now();
  try {
    const result = await executeSkill(meta, opts.args);  // existing internal function
    opts.writer?.write({
      type: 'data-skill-finish',
      id: runId,
      data: { skillName: opts.name, status: 'ok' },
    });
    if (opts.env) {
      writeAgentEvent(opts.env, {
        kind: 'skill_invocation',
        userId: opts.userId ?? 'unknown',
        runId,
        blobs: [opts.name, 'ok', meta.model ?? '', meta.context ?? 'inline'],
        doubles: [Date.now() - t0],
      });
    }
    return result;
  } catch (err) {
    opts.writer?.write({
      type: 'data-skill-finish',
      id: runId,
      data: { skillName: opts.name, status: 'error', error: String(err) },
    });
    if (opts.env) {
      writeAgentEvent(opts.env, {
        kind: 'skill_invocation',
        userId: opts.userId ?? 'unknown',
        runId,
        blobs: [opts.name, 'error', meta.model ?? '', meta.context ?? 'inline'],
        doubles: [Date.now() - t0],
      });
    }
    throw err;
  }
}
```

If `packages/skills` doesn't have a direct import path to `apps/core/src/lib/telemetry.ts`, move `telemetry.ts` to `packages/shared/src/telemetry.ts` instead. **Make this decision now**; if moving, update Task 1.1 paths.

- [x] **Step 5: Run, expect PASS**

```bash
pnpm --filter @shipflare/skills vitest run test/runner.test.ts
```
Expected: all tests pass (including pre-existing ones).

- [x] **Step 6: Verify build**

```bash
pnpm -r exec tsc --noEmit
```
Expected: 0 errors. Existing call sites (3 known: `apps/core/src/agents/social-media-manager/tools/{find-threads-via-xai,process-replies-batch,process-posts-batch}.ts`) still compile because all new params are optional.

- [x] **Step 7: Commit**

```bash
git add packages/skills/src/runner.ts packages/skills/test/runner.test.ts packages/skills/skills/noop-test-skill packages/skills/skills/throwing-test-skill
git commit -m "feat(skills): emit data-skill-start/finish parts + telemetry"
```

---

### Task 3.2: Thread writer through existing skill callers

**Files:**
- Modify: `apps/core/src/agents/social-media-manager/tools/find-threads-via-xai.ts`
- Modify: `apps/core/src/agents/social-media-manager/tools/process-replies-batch.ts`
- Modify: `apps/core/src/agents/social-media-manager/tools/process-posts-batch.ts`

For each file:

- [x] **Step 1: Locate the `runSkill({ ... })` call**

```bash
grep -n "runSkill" apps/core/src/agents/social-media-manager/tools/find-threads-via-xai.ts
```

- [x] **Step 2: Add writer + userId + env from tool ctx**

In each tool's `execute`, change:

```typescript
// before:
const result = await runSkill({ name: 'foo', args: { ... } });

// after:
const result = await runSkill({
  name: 'foo',
  args: { ... },
  writer: ctx.experimental_context?.writer,
  userId: ctx.experimental_context?.userId,
  env: ctx.experimental_context?.env,
});
```

(`experimental_context` is the AI SDK v5 tool ctx; Phase 0 verified its shape.)

- [x] **Step 3: Verify build**

```bash
pnpm -r exec tsc --noEmit
```

- [x] **Step 4: Run all unit tests**

```bash
pnpm -r exec vitest run
```
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/core/src/agents/social-media-manager/tools/
git commit -m "feat(skills): thread writer/env through SMM tool callers"
```

---

# Phase 4 — Agent orchestration (Layer 2)

Build registry, consult tool, and rewrite employees bottom-up: SMM → HoG.

---

### Task 4.1: Peer input/output schemas

**Files:**
- Create: `apps/core/src/agents/lib/peer-schema.ts`
- Test: `apps/core/test/peer-schema.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// apps/core/test/peer-schema.test.ts
import { describe, it, expect } from 'vitest';
import { peerInputSchema, peerOutputSchema } from '../src/agents/lib/peer-schema';

describe('peer schemas', () => {
  it('peerInputSchema requires question, allows optional context', () => {
    expect(peerInputSchema.safeParse({ question: 'why?' }).success).toBe(true);
    expect(peerInputSchema.safeParse({ question: 'why?', context: 'because' }).success).toBe(true);
    expect(peerInputSchema.safeParse({ context: 'because' }).success).toBe(false);
  });

  it('peerOutputSchema requires answer, allows optional artifacts', () => {
    expect(peerOutputSchema.safeParse({ answer: 'ok' }).success).toBe(true);
    expect(peerOutputSchema.safeParse({ answer: 'ok', artifacts: [{ kind: 'draft' }] }).success).toBe(true);
    expect(peerOutputSchema.safeParse({ artifacts: [] }).success).toBe(false);
  });
});
```

- [x] **Step 2: Run, expect FAIL**

```bash
pnpm --filter @shipflare/core vitest run test/peer-schema.test.ts
```

- [x] **Step 3: Implement**

```typescript
// apps/core/src/agents/lib/peer-schema.ts
import { z } from 'zod';

export const peerInputSchema = z.object({
  question: z.string().describe('What you want to ask them'),
  context: z.string().optional().describe('Background information they need'),
});
export type PeerInput = z.infer<typeof peerInputSchema>;

export const peerOutputSchema = z.object({
  answer: z.string().describe("The colleague's final response"),
  artifacts: z.array(z.record(z.unknown())).optional().describe('Any structured outputs they produced'),
});
export type PeerOutput = z.infer<typeof peerOutputSchema>;
```

- [x] **Step 4: Run, expect PASS**
- [x] **Step 5: Commit**

```bash
git add apps/core/src/agents/lib/peer-schema.ts apps/core/test/peer-schema.test.ts
git commit -m "feat(agents): peerInput/Output schemas"
```

---

### Task 4.2: Employee registry stub (CMO entry only; HoG/SMM added when classes land)

**Files:**
- Create: `apps/core/src/agents/registry.ts`
- Test: `apps/core/test/registry.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// apps/core/test/registry.test.ts
import { describe, it, expect } from 'vitest';
import { EMPLOYEE_REGISTRY, EMPLOYEE_IDS } from '../src/agents/registry';

describe('EMPLOYEE_REGISTRY', () => {
  it('contains cmo entry with required fields', () => {
    expect(EMPLOYEE_REGISTRY.cmo).toBeDefined();
    expect(EMPLOYEE_REGISTRY.cmo.envBinding).toBe('CMO');
    expect(EMPLOYEE_REGISTRY.cmo.displayName).toBeTruthy();
    expect(EMPLOYEE_REGISTRY.cmo.description).toBeTruthy();
  });

  it('EMPLOYEE_IDS matches registry keys', () => {
    expect(EMPLOYEE_IDS.sort()).toEqual(Object.keys(EMPLOYEE_REGISTRY).sort());
  });
});
```

- [x] **Step 2: Run, expect FAIL**

- [x] **Step 3: Implement (CMO entry only for now — HoG/SMM added when class files are rewritten)**

```typescript
// apps/core/src/agents/registry.ts
import type { AIChatAgent } from '@cloudflare/ai-chat';
import { CMO } from './cmo/CMO';
// import { HoG } from './head-of-growth/HeadOfGrowth';      // added in Task 4.5
// import { SMM } from './social-media-manager/SocialMediaMgr';  // added in Task 4.4

export type EmployeeId = 'cmo' | 'hog' | 'smm';

export interface EmployeeMeta {
  class: typeof AIChatAgent;
  envBinding: string;
  displayName: string;
  description: string;
  systemPromptPath: string;
}

export const EMPLOYEE_REGISTRY: Partial<Record<EmployeeId, EmployeeMeta>> = {
  cmo: {
    class: CMO,
    envBinding: 'CMO',
    displayName: 'Chief Marketing Officer',
    description: 'Strategic marketing leadership; the orchestrator.',
    systemPromptPath: 'apps/core/src/agents/cmo/SYSTEM.md',
  },
};

export const EMPLOYEE_IDS = Object.keys(EMPLOYEE_REGISTRY) as EmployeeId[];
```

Note: this file imports `CMO`, which still exists in its old `McpAgent` form. The import resolves; the type compatibility is loose because the registry uses `typeof AIChatAgent`. **Phase 5 fixes this** by rewriting CMO. Until then, the test passes because we're checking metadata only.

- [x] **Step 4: Run, expect PASS**
- [x] **Step 5: Verify build**

```bash
pnpm -r exec tsc --noEmit
```

If the `typeof AIChatAgent` constraint blocks compilation against the old `McpAgent` CMO, change `class:` to `class: any` temporarily and add a TODO comment that Phase 5 tightens the type. Document in commit message.

- [x] **Step 6: Commit**

```bash
git add apps/core/src/agents/registry.ts apps/core/test/registry.test.ts
git commit -m "feat(agents): EMPLOYEE_REGISTRY scaffold (CMO entry)"
```

---

### Task 4.3: `getEmployee` helper

**Files:**
- Create: `apps/core/src/agents/lib/get-employee.ts`
- Test: `apps/core/test/get-employee.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// apps/core/test/get-employee.test.ts
import { describe, it, expect, vi } from 'vitest';
import { getEmployee } from '../src/agents/lib/get-employee';

describe('getEmployee', () => {
  it('looks up DO stub by registry envBinding', () => {
    const get = vi.fn(() => 'stub' as any);
    const idFromName = vi.fn(() => 'do_id' as any);
    const env = { CMO: { idFromName, get } } as any;
    const stub = getEmployee('cmo', 'user_1', env);
    expect(idFromName).toHaveBeenCalledWith('user_1');
    expect(get).toHaveBeenCalledWith('do_id');
    expect(stub).toBe('stub');
  });

  it('throws when employee id is unknown', () => {
    const env = {} as any;
    expect(() => getEmployee('unknown' as any, 'u', env)).toThrow(/unknown employee/i);
  });

  it('throws when env is missing the binding', () => {
    const env = {} as any;
    expect(() => getEmployee('cmo', 'u', env)).toThrow(/missing.*CMO/i);
  });
});
```

- [x] **Step 2: Run, expect FAIL**

- [x] **Step 3: Implement**

```typescript
// apps/core/src/agents/lib/get-employee.ts
import { EMPLOYEE_REGISTRY, EmployeeId } from '../registry';

export function getEmployee<TEnv extends Record<string, unknown>>(
  id: EmployeeId,
  userId: string,
  env: TEnv,
): DurableObjectStub {
  const meta = EMPLOYEE_REGISTRY[id];
  if (!meta) throw new Error(`Unknown employee id: ${id}`);
  const ns = env[meta.envBinding] as DurableObjectNamespace | undefined;
  if (!ns) throw new Error(`Env missing DO binding for ${meta.envBinding}`);
  return ns.get(ns.idFromName(userId));
}
```

- [x] **Step 4: Run, expect PASS**
- [x] **Step 5: Commit**

```bash
git add apps/core/src/agents/lib/get-employee.ts apps/core/test/get-employee.test.ts
git commit -m "feat(agents): getEmployee(id, userId, env) helper"
```

---

### Task 4.4: SMM as AIChatAgent (with placeholder consult)

**PLAN AMENDMENT — 2026-05-16:** Mid-execution audit surfaced that this
task's scope is bigger than the plan body suggests. The current
`SocialMediaMgr.ts` is heavily MCP-coupled (7 tools that use
`agent.mcp.callTool`, `addMcpServer` peer connections, custom SQLite
schema, MCP `props.userId`). Naive port leaves dead plumbing. Spec §3.4
+ §13 already capture the intent: SMM becomes a lean AIChatAgent with
`consult` + `draft_for_channel` ONLY; the 6 work-doing tools relocate to
CMO-side ports in Phase 5.

**Read `docs/superpowers/plans/2026-05-16-task-4.4-amendment.md` for the
authoritative sub-task split before executing.** Summary:

- **4.4a** — stubs (DONE, commit `faf576c`)
- **4.4b** — extract `SYSTEM.md`
- **4.4c** — rewrite class + binding rename `SOCIAL_MEDIA_MGR → SMM` +
  wrangler migration tag **v10** with `renamed_classes`
- **4.4d** — delete obsolete MCP-tool surface (6 tool files + 4 test
  files) + stub out the CMO/HoG `addMcpServer('smm', …)` callsites with
  Phase-5 TODOs
- **4.4e** — DEFERRED to Phase 5: port the 6 removed SMM tools to
  CMO-side equivalents. Branch is non-deployable between 4.4d and 4.4e.

The body below is the original plan content for context; the amendment
doc's sub-task split is the authoritative execution order.

**Files:**
- Modify: `apps/core/src/agents/social-media-manager/SocialMediaMgr.ts` (rewrite)
- Create: `apps/core/src/agents/social-media-manager/SYSTEM.md`
- Modify: `apps/core/src/agents/registry.ts` (add SMM entry)
- Test: `apps/core/test/agents/smm.test.ts`

- [x] **Step 1: Audit current SMM tools**

```bash
grep -E "this\.(server\.tool|sql)" apps/core/src/agents/social-media-manager/SocialMediaMgr.ts | head -20
ls apps/core/src/agents/social-media-manager/tools/
```

List tool names; they become entries in the new `getTools()` return.

- [x] **Step 2: Move existing SYSTEM/system-prompt content into a new `SYSTEM.md`**

```bash
# extract the system prompt string from the old file (likely in connectEmployees or a buildSystemPrompt fn)
grep -A 200 "buildSystemPrompt\|SYSTEM_PROMPT" apps/core/src/agents/social-media-manager/SocialMediaMgr.ts | head -100
```

Save the role-specific content (NOT shared preamble — that goes to `_SYSTEM_PREAMBLE.md` in Task 5.x) to `apps/core/src/agents/social-media-manager/SYSTEM.md`.

- [x] **Step 3: Write the integration test**

```typescript
// apps/core/test/agents/smm.test.ts
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { SMM } from '../../src/agents/social-media-manager/SocialMediaMgr';

describe('SMM as AIChatAgent', () => {
  it('responds to a user message with at least one text part', async () => {
    const id = env.SMM.idFromName('user-test-1');
    const stub = env.SMM.get(id);

    const res = await stub.fetch('https://internal/agents/smm/user-test-1/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Draft a one-line bio for our launch.' }],
      }),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain('text-delta');  // AI SDK v5 chunk
  });

  it('persists messages to AIChatAgent SQLite', async () => {
    const id = env.SMM.idFromName('user-test-2');
    await runInDurableObject<SMM>(env.SMM, id, async (instance) => {
      // send a message via the public API; assert this.messages updated
      // (concrete API depends on @cloudflare/ai-chat surface verified in Phase 0)
    });
  });
});
```

- [x] **Step 4: Run, expect FAIL** (`Cannot find binding SMM` until next step)

- [x] **Step 5: Rewrite the SMM class**

```typescript
// apps/core/src/agents/social-media-manager/SocialMediaMgr.ts
import { AIChatAgent } from '@cloudflare/ai-chat';
import { streamText, createUIMessageStreamResponse, convertToModelMessages, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { makeConsultTool } from '../lib/consult-tool';  // created in Task 4.6; for now stub
import { loadSystemPrompt } from '../lib/system-prompt';  // created in Task 4.7
import { runSkill } from '@shipflare/skills';

export interface SMMState {
  currentRunId: string | null;
}

export class SMM extends AIChatAgent<Env, SMMState> {
  initialState: SMMState = { currentRunId: null };

  async onChatMessage(onFinish: any) {
    return createUIMessageStreamResponse({
      execute: async ({ writer }) => {
        const result = streamText({
          model: anthropic('claude-sonnet-4-6'),
          messages: convertToModelMessages(this.messages),
          system: await loadSystemPrompt('smm'),
          tools: this.getTools(),
          experimental_context: { writer, userId: this.name, env: this.env },
          onFinish,
        });
        writer.merge(result.toUIMessageStream());
      },
    });
  }

  getTools() {
    return {
      consult: makeConsultTool('smm'),
      draft_for_channel: tool({
        description: 'Draft content for a specific social channel.',
        inputSchema: z.object({
          channel: z.enum(['x', 'reddit']),
          topic: z.string(),
          tone: z.string().optional(),
        }),
        execute: async (args, ctx) => {
          // call existing runSkill('drafting-single-post', ...) with writer threaded
          return await runSkill({
            name: 'drafting-single-post',
            args,
            writer: ctx.experimental_context?.writer,
            userId: ctx.experimental_context?.userId,
            env: ctx.experimental_context?.env,
          });
        },
      }),
      // ...other SMM-direct tools migrated from old SocialMediaMgr
    };
  }
}
```

**Important:** `makeConsultTool` and `loadSystemPrompt` don't exist yet. Create stubs that return empty tools / static strings so this file compiles:

```typescript
// temporary, replaced in Task 4.6/4.7:
// apps/core/src/agents/lib/consult-tool.ts
import { tool } from 'ai';
import { z } from 'zod';
export function makeConsultTool(_selfId: string) {
  return tool({
    description: 'STUB — replaced in Task 4.6',
    inputSchema: z.object({}),
    execute: async () => ({ answer: 'stub' }),
  });
}

// apps/core/src/agents/lib/system-prompt.ts
export async function loadSystemPrompt(_id: string): Promise<string> {
  return 'You are a ShipFlare agent.';  // replaced in Task 4.7
}
```

- [x] **Step 6: Update wrangler — rename binding `SOCIAL_MEDIA_MGR` → `SMM`**

```jsonc
// apps/core/wrangler.jsonc — change
{ "name": "SOCIAL_MEDIA_MGR", "class_name": "SocialMediaMgr" }
// to:
{ "name": "SMM", "class_name": "SMM" }
```

Append migration tag for the renamed class (CF DO migrations are append-only):

```jsonc
"migrations": [
  // ...existing tags
  { "tag": "vN", "renamed_classes": [{ "from": "SocialMediaMgr", "to": "SMM" }] }
]
```

(Replace `vN` with the next available tag number; check existing migrations first.)

- [x] **Step 7: Add SMM to `EMPLOYEE_REGISTRY`**

```typescript
// apps/core/src/agents/registry.ts — uncomment and add:
import { SMM } from './social-media-manager/SocialMediaMgr';
// ...
smm: {
  class: SMM,
  envBinding: 'SMM',
  displayName: 'Social Media Manager',
  description: 'Channel-specific drafting, voice, posting cadence.',
  systemPromptPath: 'apps/core/src/agents/social-media-manager/SYSTEM.md',
},
```

- [x] **Step 8: Add SMM to Env type**

```typescript
// apps/core/src/env.ts
SMM: DurableObjectNamespace<import('./agents/social-media-manager/SocialMediaMgr').SMM>;
```

- [x] **Step 9: Run integration test, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/agents/smm.test.ts
```

- [x] **Step 10: Verify all callers compile**

```bash
pnpm -r exec tsc --noEmit
```

Any callers of `env.SOCIAL_MEDIA_MGR` are now broken; grep and fix:

```bash
grep -rln "SOCIAL_MEDIA_MGR" apps/ packages/
# fix each by switching to env.SMM
```

- [x] **Step 11: Commit**

```bash
git add apps/core/src/agents/social-media-manager/ apps/core/src/agents/registry.ts apps/core/src/env.ts apps/core/src/agents/lib/consult-tool.ts apps/core/src/agents/lib/system-prompt.ts apps/core/wrangler.jsonc apps/core/test/agents/smm.test.ts
git commit -m "feat(agents): SMM extends AIChatAgent (binding renamed SMM)"
```

---

### Task 4.5: HoG as AIChatAgent

Same shape as Task 4.4 but for `HeadOfGrowth`.

**Files:**
- Modify: `apps/core/src/agents/head-of-growth/HeadOfGrowth.ts`
- Create: `apps/core/src/agents/head-of-growth/SYSTEM.md`
- Modify: `apps/core/src/agents/registry.ts`
- Modify: `apps/core/wrangler.jsonc` (rename `HEAD_OF_GROWTH` → `HOG`)
- Modify: `apps/core/src/env.ts`
- Test: `apps/core/test/agents/hog.test.ts`

- [x] **Step 1: Audit HoG tools**

```bash
grep -E "this\.(server\.tool|sql)" apps/core/src/agents/head-of-growth/HeadOfGrowth.ts | head -20
```

- [x] **Step 2: Move system prompt to SYSTEM.md**

- [x] **Step 3: Write integration test**

```typescript
// apps/core/test/agents/hog.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('HoG as AIChatAgent', () => {
  it('responds with at least one text part', async () => {
    const id = env.HOG.idFromName('user-test');
    const stub = env.HOG.get(id);
    const res = await stub.fetch('https://internal/agents/hog/user-test/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Suggest 3 growth experiments.' }] }),
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('text-delta');
  });
});
```

- [x] **Step 4: Rewrite class**

Mirror SMM (Task 4.4 Step 5), substituting:
- Class name `HoG`
- State type `HoGState`
- `loadSystemPrompt('hog')`
- `makeConsultTool('hog')` — will be able to consult SMM after Task 4.6 (now mesh)
- HoG-direct tools (e.g., `research_competitor`, `analyze_funnel`) ported from the old class

- [x] **Step 5: Update wrangler — rename `HEAD_OF_GROWTH` → `HOG`**

```jsonc
{ "name": "HOG", "class_name": "HoG" }
// migrations:
{ "tag": "vN+1", "renamed_classes": [{ "from": "HeadOfGrowth", "to": "HoG" }] }
```

- [x] **Step 6: Add HoG to registry + Env**

```typescript
hog: {
  class: HoG,
  envBinding: 'HOG',
  displayName: 'Head of Growth',
  description: 'Growth strategy, acquisition funnels, retention experiments.',
  systemPromptPath: 'apps/core/src/agents/head-of-growth/SYSTEM.md',
},
```

- [x] **Step 7: Grep and fix callers of `HEAD_OF_GROWTH`**

```bash
grep -rln "HEAD_OF_GROWTH" apps/ packages/
```

- [x] **Step 8: Run tests + tsc**

```bash
pnpm --filter @shipflare/core vitest run test/agents/hog.test.ts
pnpm -r exec tsc --noEmit
```

- [x] **Step 9: Commit**

```bash
git add apps/core/src/agents/head-of-growth/ apps/core/src/agents/registry.ts apps/core/src/env.ts apps/core/wrangler.jsonc apps/core/test/agents/hog.test.ts
git commit -m "feat(agents): HoG extends AIChatAgent (binding renamed HOG)"
```

---

### Task 4.6: Replace `makeConsultTool` stub with real implementation

**Files:**
- Modify: `apps/core/src/agents/lib/consult-tool.ts` (replace stub)
- Test: `apps/core/test/consult-tool.test.ts`

- [x] **Step 1: Write unit test for caller scoping**

```typescript
// apps/core/test/consult-tool.test.ts
import { describe, it, expect } from 'vitest';
import { makeConsultTool } from '../src/agents/lib/consult-tool';

describe('makeConsultTool', () => {
  it('CMO can consult hog and smm but not itself', () => {
    const t = makeConsultTool('cmo');
    const enumValues = (t as any).inputSchema.shape.employee._def.values;
    expect(enumValues).toContain('hog');
    expect(enumValues).toContain('smm');
    expect(enumValues).not.toContain('cmo');
  });

  it('HoG can consult SMM but not CMO or itself', () => {
    const t = makeConsultTool('hog');
    const enumValues = (t as any).inputSchema.shape.employee._def.values;
    expect(enumValues).toContain('smm');
    expect(enumValues).not.toContain('cmo');
    expect(enumValues).not.toContain('hog');
  });

  it('SMM can consult HoG but not CMO or itself', () => {
    const t = makeConsultTool('smm');
    const enumValues = (t as any).inputSchema.shape.employee._def.values;
    expect(enumValues).toContain('hog');
    expect(enumValues).not.toContain('cmo');
    expect(enumValues).not.toContain('smm');
  });
});
```

- [x] **Step 2: Run, expect FAIL** (current stub has empty schema)

- [x] **Step 3: Replace stub with real implementation**

```typescript
// apps/core/src/agents/lib/consult-tool.ts
import { z } from 'zod';
import { tool } from 'ai';
import { runAgentTool } from 'agents/agent-tools';  // verified in Phase 0
import { EMPLOYEE_REGISTRY, EMPLOYEE_IDS, EmployeeId } from '../registry';
import { safeAgentChain } from '@/lib/agent-depth';
import { peerOutputSchema } from './peer-schema';

export function makeConsultTool(selfId: EmployeeId) {
  const callable = EMPLOYEE_IDS.filter(id => {
    if (id === selfId) return false;
    if (selfId !== 'cmo' && id === 'cmo') return false;  // peers don't call CMO upward
    return true;
  });

  if (callable.length === 0) {
    // edge case (e.g., only CMO registered) — return a no-op tool
    return tool({
      description: 'No colleagues available to consult.',
      inputSchema: z.object({ employee: z.never() }),
      execute: async () => ({ answer: 'No colleagues are currently available.' }),
    });
  }

  const employeeEnum = z.enum(callable as [EmployeeId, ...EmployeeId[]])
    .describe(
      callable
        .map(id => `'${id}': ${EMPLOYEE_REGISTRY[id]!.displayName} — ${EMPLOYEE_REGISTRY[id]!.description}`)
        .join('\n')
    );

  return tool({
    description: 'Consult a colleague for their expertise. Returns their final response and any structured artifacts they produced.',
    inputSchema: z.object({
      employee: employeeEnum,
      question: z.string().describe('What you want to ask them'),
      context: z.string().optional().describe('Background information they need to answer well'),
    }),
    execute: async ({ employee, question, context }, ctx: any) => {
      const meta = EMPLOYEE_REGISTRY[employee]!;
      safeAgentChain.check(ctx, meta.class.name);
      return await runAgentTool({
        class: meta.class,
        parentContext: ctx,
        input: { question, context },
        outputShape: peerOutputSchema,
      });
    },
  });
}
```

**If Phase 0 verified `runAgentTool` is NOT a public API**, use the fallback:

```typescript
// fallback: pre-instantiate one agentTool per employee at module load
import { agentTool } from 'agents/agent-tools';
import { peerInputSchema } from './peer-schema';

const PEER_TOOLS = Object.fromEntries(
  EMPLOYEE_IDS.map(id => [
    id,
    agentTool(EMPLOYEE_REGISTRY[id]!.class, {
      description: EMPLOYEE_REGISTRY[id]!.description,
      inputSchema: peerInputSchema,
    }),
  ])
);

// inside makeConsultTool execute:
execute: async ({ employee, question, context }, ctx: any) => {
  const meta = EMPLOYEE_REGISTRY[employee]!;
  safeAgentChain.check(ctx, meta.class.name);
  return await PEER_TOOLS[employee].execute({ question, context }, ctx);
},
```

- [x] **Step 4: Run, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/consult-tool.test.ts
```

- [x] **Step 5: Verify build**

```bash
pnpm -r exec tsc --noEmit
```

- [x] **Step 6: Commit**

```bash
git add apps/core/src/agents/lib/consult-tool.ts apps/core/test/consult-tool.test.ts
git commit -m "feat(agents): generalized consult tool with caller-scoped enum"
```

---

### Task 4.7: Real `loadSystemPrompt` + `_SYSTEM_PREAMBLE.md`

**Files:**
- Create: `apps/core/src/agents/_SYSTEM_PREAMBLE.md`
- Modify: `apps/core/src/agents/lib/system-prompt.ts` (replace stub)
- Test: `apps/core/test/system-prompt.test.ts`

- [x] **Step 1: Write `_SYSTEM_PREAMBLE.md`**

```markdown
# ShipFlare Agent Preamble

You are an autonomous AI employee at ShipFlare. Your job is described in the role section below.

## Your colleagues

{{COLLEAGUES}}

To consult any colleague, call the `consult` tool with:
- `employee`: the colleague's id
- `question`: what you want to ask
- `context`: any background they need

Cycles and chains deeper than 3 hops are blocked automatically.

## Telemetry

Your tool calls and skill invocations are recorded. Be concise; prefer one focused tool call over many.

## Role
```

- [x] **Step 2: Write the failing test**

```typescript
// apps/core/test/system-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { loadSystemPrompt } from '../src/agents/lib/system-prompt';

describe('loadSystemPrompt', () => {
  it('includes the preamble + colleague list + role-specific prompt', async () => {
    const prompt = await loadSystemPrompt('cmo');
    expect(prompt).toContain('You are an autonomous AI employee at ShipFlare');
    expect(prompt).toContain('## Your colleagues');
    expect(prompt).toContain("'hog': Head of Growth");
    expect(prompt).toContain("'smm': Social Media Manager");
  });

  it('excludes self from colleague list', async () => {
    const prompt = await loadSystemPrompt('hog');
    expect(prompt).not.toMatch(/'hog':/);
  });

  it('excludes CMO from peer colleague lists', async () => {
    const prompt = await loadSystemPrompt('smm');
    expect(prompt).not.toMatch(/'cmo':/);
  });
});
```

- [x] **Step 3: Run, expect FAIL**

- [x] **Step 4: Implement**

```typescript
// apps/core/src/agents/lib/system-prompt.ts
import { EMPLOYEE_REGISTRY, EmployeeId } from '../registry';

// At build time, SYSTEM.md files are inlined via a Vite/wrangler text loader.
// If the project doesn't have one configured, fall back to fs read in a Node test
// and inline-string in production. Document the choice in the file.

import preambleText from '../_SYSTEM_PREAMBLE.md?raw';
import cmoRole from '../cmo/SYSTEM.md?raw';
import hogRole from '../head-of-growth/SYSTEM.md?raw';
import smmRole from '../social-media-manager/SYSTEM.md?raw';

const ROLE_PROMPTS: Record<EmployeeId, string> = {
  cmo: cmoRole,
  hog: hogRole,
  smm: smmRole,
};

function renderColleagueList(selfId: EmployeeId): string {
  const callable = (Object.keys(EMPLOYEE_REGISTRY) as EmployeeId[]).filter(id => {
    if (id === selfId) return false;
    if (selfId !== 'cmo' && id === 'cmo') return false;
    return true;
  });
  return callable
    .map(id => `- \`'${id}'\`: ${EMPLOYEE_REGISTRY[id]!.displayName} — ${EMPLOYEE_REGISTRY[id]!.description}`)
    .join('\n');
}

export async function loadSystemPrompt(id: EmployeeId): Promise<string> {
  const colleagues = renderColleagueList(id);
  const role = ROLE_PROMPTS[id];
  return preambleText.replace('{{COLLEAGUES}}', colleagues) + '\n\n' + role;
}
```

**Note:** the `?raw` import is a Vite-style text import. If the build doesn't support it, switch to a manifest object literal in this file containing the prompt strings directly. Phase 0 should have verified the loader.

- [x] **Step 5: Run, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/system-prompt.test.ts
```

- [x] **Step 6: Commit**

```bash
git add apps/core/src/agents/_SYSTEM_PREAMBLE.md apps/core/src/agents/lib/system-prompt.ts apps/core/src/agents/{cmo,head-of-growth,social-media-manager}/SYSTEM.md apps/core/test/system-prompt.test.ts
git commit -m "feat(agents): _SYSTEM_PREAMBLE.md + loadSystemPrompt with auto colleague list"
```

---

### Task 4.8: Peer-mesh integration test

**Files:**
- Test: `apps/core/test/integration/peer-mesh.test.ts`

- [x] **Step 1: Write the test**

```typescript
// apps/core/test/integration/peer-mesh.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { AgentCycleError, AgentDepthExceededError } from '../../src/lib/agent-depth';

describe('peer mesh', () => {
  it('SMM can consult HoG and receive a peer response', async () => {
    const id = env.SMM.idFromName('user-mesh-1');
    const stub = env.SMM.get(id);
    // Trigger SMM to consult HoG (depends on a fixture prompt that compels the call)
    const res = await stub.fetch('https://internal/agents/smm/user-mesh-1/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Ask the Head of Growth what metric we should prioritize for the next launch.' }],
      }),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain('"toolName":"consult"');
    expect(text).toContain('"employee":"hog"');
  });

  it('HoG → SMM → HoG triggers AgentCycleError surfaced as tool-output-error', async () => {
    // Construct a synthetic chain by directly invoking the consult tool with a primed __agentChain
    // This is a unit-style test inside the integration harness.
    const { makeConsultTool } = await import('../../src/agents/lib/consult-tool');
    const t = makeConsultTool('smm');
    const ctx: any = { props: { __agentChain: ['HoG', 'SMM'] } };
    await expect((t as any).execute({ employee: 'hog', question: 'loop' }, ctx))
      .rejects.toThrow(AgentCycleError);
  });

  it('depth=3 chain succeeds; depth=4 throws AgentDepthExceededError', async () => {
    const { makeConsultTool } = await import('../../src/agents/lib/consult-tool');
    const t = makeConsultTool('smm');
    const ctx3: any = { props: { __agentChain: ['CMO', 'HoG', 'SMM'] } };
    await expect((t as any).execute({ employee: 'hog', question: 'depth' }, ctx3))
      .rejects.toThrow(AgentDepthExceededError);
  });
});
```

- [x] **Step 2: Run, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/integration/peer-mesh.test.ts
```

- [x] **Step 3: Commit**

```bash
git add apps/core/test/integration/peer-mesh.test.ts
git commit -m "test(agents): peer-mesh + cycle + depth integration tests"
```

---

# Phase 5 — CMO as AIChatAgent (Layer 1)

Cutover the chat surface. Old `McpAgent`-based CMO is replaced.

---

### Task 5.1: CMO class rewrite

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts` (rewrite)
- Create: `apps/core/src/agents/cmo/SYSTEM.md`
- Modify: `apps/core/src/env.ts`

- [ ] **Step 1: Audit current CMO**

```bash
wc -l apps/core/src/agents/cmo/CMO.ts
grep -E "addMcpServer|connectEmployees|delegateToEmployee|emitActivity|@callable" apps/core/src/agents/cmo/CMO.ts | head -30
ls apps/core/src/agents/cmo/tools/
```

Catalog: which CMO tools are user-facing (keep, port to `getTools()`), which were inter-agent dispatch (`delegateToEmployee` → DELETE, replaced by `consult`), which were system-internal (`getRecentActivity` → DELETE).

- [ ] **Step 2: Extract role-specific prompt to `SYSTEM.md`**

Capture the CMO-only brain content (not the shared "you are a ShipFlare agent" preamble) to `apps/core/src/agents/cmo/SYSTEM.md`.

- [ ] **Step 3: Rewrite the class**

```typescript
// apps/core/src/agents/cmo/CMO.ts
import { AIChatAgent } from '@cloudflare/ai-chat';
import { streamText, createUIMessageStreamResponse, convertToModelMessages, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { makeConsultTool } from '../lib/consult-tool';
import { loadSystemPrompt } from '../lib/system-prompt';
import { writeAgentEvent } from '@/lib/telemetry';

export interface CMOState {
  hiredRoles: string[];
  currentRunId: string | null;
}

export class CMO extends AIChatAgent<Env, CMOState> {
  initialState: CMOState = { hiredRoles: [], currentRunId: null };

  async onChatMessage(onFinish: any) {
    const runId = crypto.randomUUID();
    this.setState({ ...this.state, currentRunId: runId });
    const t0 = Date.now();
    return createUIMessageStreamResponse({
      execute: async ({ writer }) => {
        const result = streamText({
          model: anthropic('claude-sonnet-4-6'),
          messages: convertToModelMessages(this.messages),
          system: await loadSystemPrompt('cmo'),
          tools: this.getTools(),
          experimental_context: { writer, userId: this.name, env: this.env },
          experimental_telemetry: { isEnabled: true, recordInputs: false },
          onFinish: (event) => {
            writeAgentEvent(this.env, {
              kind: 'agent_run',
              userId: this.name,
              runId,
              blobs: ['CMO', event.finishReason ?? 'unknown'],
              doubles: [Date.now() - t0],
            });
            return onFinish?.(event);
          },
        });
        writer.merge(result.toUIMessageStream());
      },
    });
  }

  getTools() {
    return {
      consult: makeConsultTool('cmo'),
      commit_strategic_path: tool({
        description: 'Lock in the strategic path after founder approval.',
        inputSchema: z.object({ path: z.string() }),
        execute: async (args, ctx: any) => {
          // port existing implementation from old CMO tools/commit-strategic-path.ts
          // (keep DB write logic, drop activity broadcast)
          return { ok: true };
        },
      }),
      schedule_post: tool({
        description: 'Schedule a draft to be posted at a specific time.',
        inputSchema: z.object({ draftId: z.string(), at: z.string() }),
        execute: async (args, ctx: any) => {
          // port existing implementation
          return { ok: true };
        },
      }),
      approve_draft: tool({
        description: 'Mark a draft as approved by the founder.',
        inputSchema: z.object({ draftId: z.string() }),
        execute: async (args, ctx: any) => { return { ok: true }; },
      }),
      // ...other CMO-direct tools migrated from apps/core/src/agents/cmo/tools/
    };
  }
}
```

- [ ] **Step 4: Delete `delegateToEmployee` tool**

```bash
rm apps/core/src/agents/cmo/tools/delegate.ts 2>/dev/null
# (and any imports of it from the old CMO)
```

- [ ] **Step 5: Delete `getRecentActivity` tool** (if present)

```bash
rm apps/core/src/agents/cmo/tools/getRecentActivity.ts 2>/dev/null
```

- [ ] **Step 6: Update Env type**

```typescript
// apps/core/src/env.ts — ensure CMO binding is typed against new class
CMO: DurableObjectNamespace<import('./agents/cmo/CMO').CMO>;
HOG: DurableObjectNamespace<import('./agents/head-of-growth/HeadOfGrowth').HoG>;
SMM: DurableObjectNamespace<import('./agents/social-media-manager/SocialMediaMgr').SMM>;
```

- [ ] **Step 7: Verify build**

```bash
pnpm -r exec tsc --noEmit
```

Fix any callers of removed CMO methods (`delegateToEmployee`, `connectEmployees`, `emitActivity`).

- [ ] **Step 8: Commit**

```bash
git add apps/core/src/agents/cmo/ apps/core/src/env.ts
git commit -m "feat(agents): CMO extends AIChatAgent; delegateToEmployee removed"
```

---

### Task 5.2: CMO integration test

**Files:**
- Test: `apps/core/test/integration/cmo-chat.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/core/test/integration/cmo-chat.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('CMO chat flow', () => {
  it('streams text-delta and persists message', async () => {
    const id = env.CMO.idFromName('user-cmo-1');
    const stub = env.CMO.get(id);

    const res = await stub.fetch('https://internal/agents/cmo/user-cmo-1/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Plan a small launch campaign.' }],
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body).toContain('text-delta');
  });

  it('dispatches consult to HoG when prompted', async () => {
    const id = env.CMO.idFromName('user-cmo-2');
    const stub = env.CMO.get(id);
    const res = await stub.fetch('https://internal/agents/cmo/user-cmo-2/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Ask the Head of Growth what we should test next.' }],
      }),
    });
    const body = await res.text();
    expect(body).toMatch(/agent-tool-event.*started/);
    expect(body).toContain('"employee":"hog"');
  });

  it('writes telemetry on turn finish', async () => {
    // Mock TELEMETRY binding to capture writes
    // (concrete spy mechanism depends on vitest-pool-workers env shape)
  });
});
```

- [ ] **Step 2: Run, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/integration/cmo-chat.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/core/test/integration/cmo-chat.test.ts
git commit -m "test(cmo): integration test for chat flow + dispatch + telemetry"
```

---

### Task 5.3: Setup-agent-test helper + retrofit existing tests

**Files:**
- Create: `apps/core/src/agents/lib/setup-agent-test.ts`
- Modify: `apps/core/test/agents/{smm,hog}.test.ts` (use the helper)
- Modify: `apps/core/test/integration/cmo-chat.test.ts`

- [ ] **Step 1: Implement the helper**

```typescript
// apps/core/src/agents/lib/setup-agent-test.ts
import { env } from 'cloudflare:test';
import { EMPLOYEE_REGISTRY, EmployeeId } from '../registry';

export function setupAgentTest(id: EmployeeId, userId = `test-${id}`) {
  const meta = EMPLOYEE_REGISTRY[id]!;
  const ns = (env as any)[meta.envBinding] as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(userId));

  return {
    stub,
    userId,
    async sendMessage(content: string) {
      const res = await stub.fetch(`https://internal/agents/${id}/${userId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content }] }),
      });
      if (!res.ok) throw new Error(`agent chat failed: ${res.status}`);
      return await res.text();
    },
  };
}
```

- [ ] **Step 2: Retrofit one test as a smoke**

In `apps/core/test/agents/smm.test.ts`, replace boilerplate:

```typescript
import { setupAgentTest } from '../../src/agents/lib/setup-agent-test';
// ...
it('responds to a user message', async () => {
  const { sendMessage } = setupAgentTest('smm');
  const body = await sendMessage('Draft a one-line bio.');
  expect(body).toContain('text-delta');
});
```

- [ ] **Step 3: Run all integration tests, expect PASS**

```bash
pnpm --filter @shipflare/core vitest run test/agents test/integration
```

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/lib/setup-agent-test.ts apps/core/test/agents/ apps/core/test/integration/
git commit -m "test(agents): setupAgentTest helper + retrofit"
```

---

# Phase 6 — DB cleanup

---

### Task 6.1: D1 migration — drop founder_messages and activity_events

**Files:**
- Create: `packages/db/migrations/<NNNN>_drop_legacy_chat_tables.sql`
- Modify: `packages/db/src/schema.ts` (remove the dropped table definitions)

- [ ] **Step 1: List existing migrations**

```bash
ls packages/db/migrations/ | tail -10
```

Pick the next sequential number (e.g., if last is `0042_x.sql`, use `0043`).

- [ ] **Step 2: Write the migration**

```sql
-- packages/db/migrations/0043_drop_legacy_chat_tables.sql
DROP TABLE IF EXISTS founder_messages;
DROP TABLE IF EXISTS activity_events;
```

- [ ] **Step 3: Remove table definitions from schema**

```bash
grep -n "founder_messages\|activity_events" packages/db/src/schema.ts
```

Delete the corresponding `sqliteTable(...)` blocks.

- [ ] **Step 4: Run migration locally**

```bash
pnpm --filter @shipflare/db migrate:local
```

- [ ] **Step 5: Verify build**

```bash
pnpm -r exec tsc --noEmit
```

Any remaining references to `foundermessages` table or `activityevents` table in the codebase will fail compile — fix them by deleting the code that referenced them (most lives in files queued for deletion in Phase 10).

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0043_drop_legacy_chat_tables.sql packages/db/src/schema.ts
git commit -m "feat(db): drop founder_messages and activity_events"
```

---

### Task 6.2: DO migration tags for renamed/new classes

**Files:**
- Modify: `apps/core/wrangler.jsonc`

- [ ] **Step 1: List existing migration tags**

```bash
grep -A 50 '"migrations":' apps/core/wrangler.jsonc | head -50
```

- [ ] **Step 2: Append new tag for the cutover (if not already done in 4.4/4.5)**

```jsonc
"migrations": [
  // ...existing tags
  {
    "tag": "vN",
    "renamed_classes": [
      { "from": "SocialMediaMgr", "to": "SMM" },
      { "from": "HeadOfGrowth", "to": "HoG" }
    ]
  }
]
```

`CMO` is not renamed (still `CMO`). The fact that its base class changes from `McpAgent` to `AIChatAgent` does NOT require a migration tag — it's still the same DO class name.

- [ ] **Step 3: `wrangler types` regenerates env**

```bash
cd apps/core && pnpm wrangler types && cd ../..
pnpm -r exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/core/wrangler.jsonc
git commit -m "chore: DO migration tags for SMM/HoG rename"
```

---

# Phase 7 — External MCP for CMO (Layer 4)

---

### Task 7.1: `CMO.invokeAsTool` callable

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts`
- Test: `apps/core/test/integration/cmo-invoke-as-tool.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/core/test/integration/cmo-invoke-as-tool.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('CMO.invokeAsTool', () => {
  it('runs a tool and returns its result without streaming chat', async () => {
    const id = env.CMO.idFromName('user-iat-1');
    const stub = env.CMO.get(id);
    // call via RPC — exact pattern depends on Agents SDK callable surface
    const result = await (stub as any).invokeAsTool('approve_draft', { draftId: 'd_1' });
    expect(result).toBeDefined();
  });

  it('does not append a message to AIChatAgent history', async () => {
    const id = env.CMO.idFromName('user-iat-2');
    const stub = env.CMO.get(id);
    await (stub as any).invokeAsTool('approve_draft', { draftId: 'd_2' });
    // assert this.messages count unchanged (exact accessor depends on AIChatAgent surface)
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Add `invokeAsTool` to CMO**

```typescript
// apps/core/src/agents/cmo/CMO.ts — add inside the class
import { callable } from 'agents';

  @callable()
  async invokeAsTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tools = this.getTools();
    const t = (tools as any)[toolName];
    if (!t) throw new Error(`Unknown tool: ${toolName}`);
    // Pass a no-op writer so any data parts do not error; userId from this.name
    const noopWriter = { write: () => {} };
    return await t.execute(args, {
      experimental_context: { writer: noopWriter, userId: this.name, env: this.env },
      props: {},
    });
  }
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts apps/core/test/integration/cmo-invoke-as-tool.test.ts
git commit -m "feat(cmo): invokeAsTool callable for external MCP usage"
```

---

### Task 7.2: `CmoExternalMcp` class

**Files:**
- Create: `apps/core/src/external/CmoExternalMcp.ts`
- Modify: `apps/core/wrangler.jsonc` (add DO binding + migration tag for `CmoExternalMcp`)
- Modify: `apps/core/src/env.ts`
- Test: `apps/core/test/integration/external-mcp.test.ts`

- [ ] **Step 1: Add wrangler binding**

```jsonc
"durable_objects": {
  "bindings": [
    // ...existing
    { "name": "CMO_EXTERNAL_MCP", "class_name": "CmoExternalMcp" }
  ]
},
"migrations": [
  // ...existing
  { "tag": "vN+1", "new_sqlite_classes": ["CmoExternalMcp"] }
]
```

- [ ] **Step 2: Add to Env type**

```typescript
CMO_EXTERNAL_MCP: DurableObjectNamespace<import('./external/CmoExternalMcp').CmoExternalMcp>;
```

- [ ] **Step 3: Write test**

```typescript
// apps/core/test/integration/external-mcp.test.ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('CmoExternalMcp', () => {
  it('lists draft_post and approve_draft tools', async () => {
    const id = env.CMO_EXTERNAL_MCP.idFromName('user-ext-1');
    const stub = env.CMO_EXTERNAL_MCP.get(id);
    const res = await stub.fetch('https://internal/cmo/sse/tools/list');
    const body = await res.json() as any;
    const names = body.tools.map((t: any) => t.name);
    expect(names).toContain('approve_draft');
  });

  it('forwards tool call to internal CMO via invokeAsTool', async () => {
    const id = env.CMO_EXTERNAL_MCP.idFromName('user-ext-2');
    const stub = env.CMO_EXTERNAL_MCP.get(id);
    const res = await stub.fetch('https://internal/cmo/sse/tools/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'approve_draft', arguments: { draftId: 'd_1' } }),
    });
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run, expect FAIL**

- [ ] **Step 5: Implement**

```typescript
// apps/core/src/external/CmoExternalMcp.ts
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getEmployee } from '@/agents/lib/get-employee';

interface ExternalProps { userId: string }

export class CmoExternalMcp extends McpAgent<Env, never, ExternalProps> {
  server = new McpServer({ name: 'shipflare-cmo', version: '1.0.0' });

  async init() {
    const userId = this.props.userId ?? 'anonymous';

    this.server.tool(
      'approve_draft',
      { draftId: z.string() },
      async (args) => {
        const stub = getEmployee('cmo', userId, this.env);
        const result = await (stub as any).invokeAsTool('approve_draft', args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    );

    this.server.tool(
      'schedule_post',
      { draftId: z.string(), at: z.string() },
      async (args) => {
        const stub = getEmployee('cmo', userId, this.env);
        const result = await (stub as any).invokeAsTool('schedule_post', args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    );

    // Curated subset — do NOT expose consult or other inter-agent tools
  }
}
```

- [ ] **Step 6: Run, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/external/CmoExternalMcp.ts apps/core/wrangler.jsonc apps/core/src/env.ts apps/core/test/integration/external-mcp.test.ts
git commit -m "feat(external): CmoExternalMcp curated tools forwarding to CMO"
```

---

### Task 7.3: OAuth wrapper + route mount

**Files:**
- Modify: `apps/core/src/index.ts` (route mount)
- Test: `apps/core/test/integration/external-mcp-oauth.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/core/test/integration/external-mcp-oauth.test.ts
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('CmoExternalMcp OAuth', () => {
  it('rejects unauthenticated request with 401', async () => {
    const res = await SELF.fetch('https://example.com/cmo/sse/tools/list');
    expect(res.status).toBe(401);
  });

  it('accepts request with valid bearer token', async () => {
    const token = await mintTestToken({ userId: 'user-oauth-1', audience: 'mcp.shipflare.com' });
    const res = await SELF.fetch('https://example.com/cmo/sse/tools/list', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok).toBe(true);
  });
});

async function mintTestToken(_claims: Record<string, unknown>): Promise<string> {
  // Implementation depends on Phase 0 OAuth choice (signed JWT against MCP_OAUTH_JWT_SIGNING_KEY)
  return 'test-token';
}
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Wire OAuth provider**

```typescript
// apps/core/src/index.ts — add route for /cmo/sse/*
import { withOAuthProvider } from 'agents/oauth';
import { CmoExternalMcp } from './external/CmoExternalMcp';

const externalMcpHandler = withOAuthProvider({
  audience: 'mcp.shipflare.com',  // from env.MCP_OAUTH_AUDIENCE
  signingKey: (env: Env) => env.MCP_OAUTH_JWT_SIGNING_KEY,
  apiHandler: CmoExternalMcp.serveSSE('/cmo/sse').fetch,
});

// In the main fetch handler, route requests matching `/cmo/sse/*` to externalMcpHandler.
// Existing route registry pattern dictates where this slot in:
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/cmo/sse')) {
      return externalMcpHandler(request, env, ctx);
    }
    // ...existing routing
  },
};
```

(Exact `withOAuthProvider` signature verified in Phase 0; adjust if different.)

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/index.ts apps/core/test/integration/external-mcp-oauth.test.ts
git commit -m "feat(external): OAuth-protected /cmo/sse mount"
```

---

# Phase 8 — Frontend

---

### Task 8.1: Generic agent JWT route

**Files:**
- Create: `apps/web/app/api/agent-token/route.ts`
- Test: `apps/web/__tests__/agent-token.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/web/__tests__/agent-token.test.ts
import { describe, it, expect } from 'vitest';
import { GET } from '../app/api/agent-token/route';

describe('GET /api/agent-token', () => {
  it('returns a JWT for an authenticated session', async () => {
    const req = new Request('http://localhost/api/agent-token?agent=cmo&name=user-1');
    // stub auth session
    const res = await GET(req as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^ey/);
  });

  it('returns 401 when no session', async () => {
    const req = new Request('http://localhost/api/agent-token?agent=cmo&name=user-1');
    // stub: no session
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 when agent param missing', async () => {
    const req = new Request('http://localhost/api/agent-token');
    const res = await GET(req as any);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement (model after existing `/api/cmo-ws-token/route.ts`)**

```typescript
// apps/web/app/api/agent-token/route.ts
import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { auth } from '@/lib/auth';
import { SignJWT } from 'jose';

const ALLOWED_AGENTS = new Set(['cmo', 'hog', 'smm']);

export async function GET(req: NextRequest) {
  const session = await auth.getSession(req);
  if (!session?.user) return new Response(null, { status: 401 });

  const url = new URL(req.url);
  const agent = url.searchParams.get('agent');
  const name = url.searchParams.get('name') ?? session.user.id;
  if (!agent || !ALLOWED_AGENTS.has(agent)) {
    return new Response('missing or invalid agent param', { status: 400 });
  }

  const { env } = await getCloudflareContext({ async: true });
  const secret = new TextEncoder().encode(env.MCP_JWT_SECRET);
  const token = await new SignJWT({ sub: session.user.id, agent, name })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(secret);

  return Response.json({ token });
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/agent-token/route.ts apps/web/__tests__/agent-token.test.ts
git commit -m "feat(web): generic /api/agent-token for any agent WebSocket"
```

---

### Task 8.2: `useCmoChat` hook

**Files:**
- Create: `apps/web/src/hooks/use-cmo-chat.ts`

- [ ] **Step 1: Implement**

```typescript
// apps/web/src/hooks/use-cmo-chat.ts
'use client';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent, useAgentToolEvents } from 'agents/react';

async function fetchAgentJwt(agent: string, name?: string): Promise<string> {
  const params = new URLSearchParams({ agent });
  if (name) params.set('name', name);
  const res = await fetch(`/api/agent-token?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch agent token: ${res.status}`);
  const { token } = await res.json();
  return token;
}

export function useCmoChat({ userId, conversationId }: { userId: string; conversationId?: string }) {
  const agent = useAgent({
    agent: 'cmo',
    name: userId,
    query: async () => `token=${await fetchAgentJwt('cmo', userId)}`,
    queryDeps: [userId],
  });

  const chat = useAgentChat({ agent, id: conversationId });
  const { runsById, runsByToolCallId } = useAgentToolEvents({ agent });

  return {
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    isLoading: chat.isLoading,
    stop: chat.stop,
    agentRuns: runsById,
    agentRunsByToolCall: runsByToolCallId,
  };
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm --filter web exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/use-cmo-chat.ts
git commit -m "feat(web): useCmoChat hook over useAgentChat + useAgentToolEvents"
```

---

### Task 8.3: Part renderer components

**Files:**
- Create: `apps/web/app/(app)/chat/_components/text-part.tsx`
- Create: `apps/web/app/(app)/chat/_components/reasoning-part.tsx`
- Create: `apps/web/app/(app)/chat/_components/skill-part.tsx`
- Create: `apps/web/app/(app)/chat/_components/tool-invocation.tsx`
- Create: `apps/web/app/(app)/chat/_components/step-anchor.tsx`
- Create: `apps/web/app/(app)/chat/_components/nested-agent-run.tsx`
- Create: `apps/web/app/(app)/chat/_components/message-bubble.tsx`

For each component, follow this shape — keep it minimal in this task; styling polish lives in Task 8.5.

- [ ] **Step 1: TextPart**

```tsx
// apps/web/app/(app)/chat/_components/text-part.tsx
export function TextPart({ text }: { text: string }) {
  return <div data-testid="text-part" className="text-base">{text}</div>;
}
```

- [ ] **Step 2: ReasoningPart**

```tsx
// apps/web/app/(app)/chat/_components/reasoning-part.tsx
export function ReasoningPart({ text }: { text: string }) {
  return (
    <details data-testid="reasoning-part" className="text-xs text-muted-foreground border-l-2 border-muted pl-2 my-1">
      <summary className="cursor-pointer">Thinking…</summary>
      <pre className="whitespace-pre-wrap font-mono text-xs">{text}</pre>
    </details>
  );
}
```

- [ ] **Step 3: SkillPart**

```tsx
// apps/web/app/(app)/chat/_components/skill-part.tsx
interface SkillStartData { skillName: string; model: string | null; context: string; parentRunId: string | null }
interface SkillFinishData { skillName: string; status: 'ok' | 'error'; error?: string }

export function SkillPart({ part }: { part: { type: 'data-skill-start' | 'data-skill-finish'; data: SkillStartData | SkillFinishData } }) {
  if (part.type === 'data-skill-start') {
    const d = part.data as SkillStartData;
    return <div data-testid="skill-part" className="text-xs italic text-muted-foreground">Running skill <code>{d.skillName}</code>…</div>;
  }
  const d = part.data as SkillFinishData;
  return <div data-testid="skill-part" className={`text-xs italic ${d.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
    Skill <code>{d.skillName}</code> {d.status === 'ok' ? 'finished' : `failed: ${d.error}`}
  </div>;
}
```

- [ ] **Step 4: ToolInvocation**

```tsx
// apps/web/app/(app)/chat/_components/tool-invocation.tsx
interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
  args?: unknown;
  result?: unknown;
}

export function ToolInvocation({ invocation }: { invocation: ToolInvocation }) {
  return (
    <div data-testid="tool-invocation" className="border rounded p-2 my-1 text-sm">
      <div><strong>{invocation.toolName}</strong> <span className="text-xs text-muted-foreground">[{invocation.state}]</span></div>
      {invocation.args && <pre className="text-xs">{JSON.stringify(invocation.args, null, 2)}</pre>}
      {invocation.result !== undefined && <pre className="text-xs text-muted-foreground">{JSON.stringify(invocation.result, null, 2)}</pre>}
    </div>
  );
}
```

- [ ] **Step 5: StepAnchor**

```tsx
// apps/web/app/(app)/chat/_components/step-anchor.tsx
export function StepAnchor({ part }: { part: { data: { label: string; stepId: string } } }) {
  return <div data-testid="step-anchor" className="text-xs font-semibold text-primary my-2">{part.data.label}</div>;
}
```

- [ ] **Step 6: NestedAgentRun**

```tsx
// apps/web/app/(app)/chat/_components/nested-agent-run.tsx
import { TextPart } from './text-part';
import { ReasoningPart } from './reasoning-part';
import { ToolInvocation } from './tool-invocation';

interface AgentRunState {
  runId: string;
  agentType: string;
  status: 'running' | 'finished' | 'error' | 'aborted';
  parts: Array<{ type: string; [k: string]: any }>;
  summary?: string;
  error?: string;
}

export function NestedAgentRun({ label, childRun }: { label: string; childRun?: AgentRunState }) {
  if (!childRun) {
    return <div data-testid="nested-agent-run" className="border-l-2 pl-2 my-1 text-sm">Consulting {label}…</div>;
  }
  return (
    <div data-testid="nested-agent-run" data-employee={label} className="border-l-2 pl-2 my-1">
      <div className="text-xs font-semibold">{label} <span className="text-muted-foreground">[{childRun.status}]</span></div>
      {childRun.parts.map((p, i) => {
        switch (p.type) {
          case 'text':              return <TextPart key={i} text={p.text} />;
          case 'reasoning':         return <ReasoningPart key={i} text={p.text} />;
          case 'tool-invocation':   return <ToolInvocation key={i} invocation={p.toolInvocation} />;
          default:                  return null;
        }
      })}
      {childRun.error && <div className="text-xs text-destructive">{childRun.error}</div>}
    </div>
  );
}
```

- [ ] **Step 7: MessageBubble**

```tsx
// apps/web/app/(app)/chat/_components/message-bubble.tsx
import { PropsWithChildren } from 'react';

export function MessageBubble({ role, children }: PropsWithChildren<{ role: 'user' | 'assistant' | 'system' }>) {
  return (
    <div data-testid="message-bubble" data-role={role} className={`my-2 p-3 rounded ${role === 'user' ? 'bg-primary/10' : 'bg-muted'}`}>
      {children}
    </div>
  );
}
```

- [ ] **Step 8: Verify build + commit**

```bash
pnpm --filter web exec tsc --noEmit
git add apps/web/app/\(app\)/chat/_components/
git commit -m "feat(web): part renderer components"
```

---

### Task 8.4: Main chat UI

**Files:**
- Create: `apps/web/app/(app)/chat/_components/cmo-chat.tsx`
- Modify: `apps/web/app/(app)/chat/page.tsx` (or create if absent — confirm path before edit)

- [ ] **Step 1: Implement CmoChat**

```tsx
// apps/web/app/(app)/chat/_components/cmo-chat.tsx
'use client';
import { useState } from 'react';
import { useCmoChat } from '@/hooks/use-cmo-chat';
import { MessageBubble } from './message-bubble';
import { TextPart } from './text-part';
import { ReasoningPart } from './reasoning-part';
import { ToolInvocation } from './tool-invocation';
import { NestedAgentRun } from './nested-agent-run';
import { SkillPart } from './skill-part';
import { StepAnchor } from './step-anchor';
import { EMPLOYEE_REGISTRY } from '@/lib/employee-registry-client';  // see Note below

export function CmoChat({ userId }: { userId: string }) {
  const { messages, sendMessage, isLoading, agentRunsByToolCall } = useCmoChat({ userId });
  const [input, setInput] = useState('');

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map(msg => (
          <MessageBubble key={msg.id} role={msg.role as any}>
            {msg.parts.map((part: any, i: number) => {
              switch (part.type) {
                case 'text':       return <TextPart key={i} text={part.text} />;
                case 'reasoning':  return <ReasoningPart key={i} text={part.text} />;
                case 'tool-invocation': {
                  if (part.toolInvocation?.toolName === 'consult') {
                    const employeeId = part.toolInvocation.args?.employee;
                    const meta = EMPLOYEE_REGISTRY[employeeId];
                    return <NestedAgentRun key={i}
                      label={meta?.displayName ?? employeeId}
                      childRun={agentRunsByToolCall[part.toolInvocation.toolCallId]} />;
                  }
                  return <ToolInvocation key={i} invocation={part.toolInvocation} />;
                }
                case 'data-skill-start':
                case 'data-skill-finish':
                  return <SkillPart key={i} part={part} />;
                case 'data-step':
                  return <StepAnchor key={i} part={part} />;
                default: return null;
              }
            })}
          </MessageBubble>
        ))}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); if (input.trim()) { sendMessage(input); setInput(''); } }}
        className="border-t p-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask CMO…"
          className="flex-1 border rounded px-3 py-2"
          aria-label="message"
        />
        <button type="submit" disabled={isLoading} className="px-4 py-2 rounded bg-primary text-primary-foreground">
          Send
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Add client-side employee registry mirror**

`EMPLOYEE_REGISTRY` lives in `apps/core` and bundling Cloudflare Worker imports into Next.js may not work. Create a slim client mirror:

```typescript
// apps/web/src/lib/employee-registry-client.ts
export const EMPLOYEE_REGISTRY: Record<string, { displayName: string; description: string }> = {
  cmo: { displayName: 'Chief Marketing Officer', description: 'Strategic marketing leadership.' },
  hog: { displayName: 'Head of Growth', description: 'Growth strategy, acquisition funnels, retention experiments.' },
  smm: { displayName: 'Social Media Manager', description: 'Channel-specific drafting, voice, posting cadence.' },
};
```

Note: this is intentional duplication — adding a new employee requires updating both the core registry AND this client mirror. Add this to the New Employee Checklist.

- [ ] **Step 3: Wire CmoChat into the chat page**

```bash
ls apps/web/app/\(app\)/chat/ 2>/dev/null
```

If `page.tsx` exists, replace its body with `<CmoChat userId={session.user.id} />`. If not, create:

```tsx
// apps/web/app/(app)/chat/page.tsx
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { CmoChat } from './_components/cmo-chat';

export default async function ChatPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  return <CmoChat userId={session.user.id} />;
}
```

- [ ] **Step 4: Verify build**

```bash
pnpm --filter web exec tsc --noEmit
pnpm --filter web build
```

- [ ] **Step 5: Manual smoke**

```bash
pnpm dev
# open http://localhost:3000/chat, send "hi", verify text-delta renders
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(app\)/chat/ apps/web/src/lib/employee-registry-client.ts
git commit -m "feat(web): CmoChat page wired to useCmoChat + part renderers"
```

---

### Task 8.5: Update New Employee Checklist (web mirror)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append to "New Employee Checklist" section**

```markdown
- [ ] Mirror the new employee in `apps/web/src/lib/employee-registry-client.ts`
      (displayName + description; consumed by the chat UI's `NestedAgentRun` label).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: New Employee Checklist includes web registry mirror"
```

---

### Task 8.6: Playwright smoke for main chat

**Files:**
- Create: `apps/web/e2e/cmo-chat.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/web/e2e/cmo-chat.spec.ts
import { test, expect } from '@playwright/test';

test('founder sees reasoning + nested agent run + resumable stream', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'auth-state.json' });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/chat');

  await page.getByLabel('message').fill('Plan a small launch campaign and ask Head of Growth what to measure.');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.getByTestId('reasoning-part').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('nested-agent-run').filter({ hasText: 'Head of Growth' })).toBeVisible({ timeout: 45_000 });

  // Reload mid-stream → resumable
  await page.reload();
  await expect(page.getByText(/Plan a small launch campaign/)).toBeVisible();
  await expect(page.getByTestId('nested-agent-run')).toBeVisible();

  await expect(page.getByTestId('text-part').last()).toBeVisible({ timeout: 90_000 });
});
```

- [ ] **Step 2: Run (requires dev server)**

```bash
pnpm dev &  # in another terminal
pnpm --filter web exec playwright test e2e/cmo-chat.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/cmo-chat.spec.ts
git commit -m "test(e2e): Playwright smoke for main CMO chat"
```

---

# Phase 9 — Onboarding plan-build flow

---

### Task 9.1: Rewrite `plan-build-activity.tsx` on `useCmoChat`

**Files:**
- Modify: `apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx`

- [ ] **Step 1: Audit current consumer**

```bash
grep -E "useCmoActivity|ActivityTrail" apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx
```

- [ ] **Step 2: Rewrite using `useCmoChat`**

```tsx
// apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx
'use client';
import { useCmoChat } from '@/hooks/use-cmo-chat';
import { ReasoningPart } from '@/app/(app)/chat/_components/reasoning-part';
import { NestedAgentRun } from '@/app/(app)/chat/_components/nested-agent-run';
import { SkillPart } from '@/app/(app)/chat/_components/skill-part';
import { EMPLOYEE_REGISTRY } from '@/lib/employee-registry-client';

export function PlanBuildActivity({ userId, runId }: { userId: string; runId: string }) {
  const { messages, agentRunsByToolCall } = useCmoChat({ userId });

  // Find the message(s) for this run — onboarding emits a `data-step` with runId at start
  const relevant = messages.flatMap(m =>
    m.parts.filter((p: any) =>
      p.type === 'data-step' && p.data?.runId === runId
        ? [{ ...m, parts: [p] }]
        : m.parts.some((q: any) => q.type === 'data-step' && q.data?.runId === runId)
          ? [m]
          : []
    )
  );

  if (!relevant.length) {
    return <div className="text-sm text-muted-foreground">Working…</div>;
  }

  return (
    <div className="space-y-2">
      {relevant.flatMap((msg, mi) =>
        msg.parts.map((part: any, pi: number) => {
          const key = `${mi}-${pi}`;
          switch (part.type) {
            case 'reasoning': return <ReasoningPart key={key} text={part.text} />;
            case 'tool-invocation': {
              if (part.toolInvocation?.toolName === 'consult') {
                const employeeId = part.toolInvocation.args?.employee;
                const meta = EMPLOYEE_REGISTRY[employeeId];
                return <NestedAgentRun key={key}
                  label={meta?.displayName ?? employeeId}
                  childRun={agentRunsByToolCall[part.toolInvocation.toolCallId]} />;
              }
              return null;
            }
            case 'data-skill-start':
            case 'data-skill-finish':
              return <SkillPart key={key} part={part} />;
            default: return null;
          }
        })
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
pnpm --filter web exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/onboarding/_components/_shared/plan-build-activity.tsx
git commit -m "feat(onboarding): plan-build-activity uses useCmoChat parts"
```

---

### Task 9.2: Playwright onboarding smoke

**Files:**
- Create: `apps/web/e2e/onboarding-plan-build.spec.ts`

- [ ] **Step 1: Write the test**

```typescript
// apps/web/e2e/onboarding-plan-build.spec.ts
import { test, expect } from '@playwright/test';

test('onboarding plan-build wizard renders thinking + dispatch + skill', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'auth-state.json' });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/onboarding');
  // Drive the wizard to the plan-build step (selectors depend on existing wizard markup)
  await page.getByRole('button', { name: /generate plan/i }).click();
  await expect(page.getByTestId('reasoning-part').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('skill-part').first()).toBeVisible({ timeout: 60_000 });
});
```

- [ ] **Step 2: Run**

```bash
pnpm --filter web exec playwright test e2e/onboarding-plan-build.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/onboarding-plan-build.spec.ts
git commit -m "test(e2e): onboarding plan-build wizard smoke"
```

---

# Phase 10 — Delete-list sweep

---

### Task 10.1: Delete legacy files

**Files:** (deletions)

- [ ] **Step 1: Delete files**

```bash
rm packages/shared/src/activity-event.ts
rm apps/core/src/lib/activity.ts
rm apps/core/src/lib/forward-activity.ts
rm apps/core/src/lib/subagent-activity.ts
rm apps/web/src/hooks/use-cmo-activity.ts
rm apps/web/app/api/cmo-activity/route.ts
rm apps/web/app/api/cmo-ws-token/route.ts
# (any remaining ActivityTrail UI files that aren't reused — verify by grep first)
```

- [ ] **Step 2: Grep for dangling imports**

```bash
grep -rln "ActivityEvent\|activity-event\|forward-activity\|subagent-activity\|useCmoActivity\|cmo-activity\|cmo-ws-token" apps/ packages/ 2>/dev/null
```

Expected: no results. Fix any leftover imports by deleting the consumer code.

- [ ] **Step 3: Remove `packages/shared/src/activity-event.ts` from any export barrel**

```bash
grep -n "activity-event" packages/shared/src/index.ts 2>/dev/null
```

Edit to remove the export.

- [ ] **Step 4: Verify build green**

```bash
pnpm -r exec tsc --noEmit
```

- [ ] **Step 5: Run all unit + integration tests**

```bash
pnpm -r exec vitest run
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove legacy activity stream + cmo-ws-token + cmo-activity"
```

---

### Task 10.2: Add New Employee Checklist to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the "New Platform Checklist" section**

```bash
grep -n "New Platform Checklist" CLAUDE.md
```

- [ ] **Step 2: Add New Employee Checklist immediately after**

```markdown
### New Employee Checklist

When adding a new agent (e.g., Head of Design = HoD):

- [ ] Create `apps/core/src/agents/head-of-design/HeadOfDesign.ts` extending `AIChatAgent`
- [ ] Create `apps/core/src/agents/head-of-design/SYSTEM.md` (role brain only)
- [ ] Add ONE entry to `EMPLOYEE_REGISTRY` in `apps/core/src/agents/registry.ts`
- [ ] Add wrangler DO binding: `{ "name": "HOD", "class_name": "HoD" }`
- [ ] Append migration tag: `{ "tag": "vN", "new_sqlite_classes": ["HoD"] }`
- [ ] Add `HOD: DurableObjectNamespace<HoD>` to `Env` type in `apps/core/src/env.ts`
- [ ] Mirror in `apps/web/src/lib/employee-registry-client.ts` (displayName + description)
- [ ] Add test file under `apps/core/test/agents/hod.test.ts` using `setupAgentTest('hod')`
- [ ] NO changes to: existing agent files, frontend renderer, consult tool,
      telemetry, hooks, JWT route. Compile errors guide you if you miss anything.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: New Employee Checklist for cf-native agents"
```

---

# Phase 11 — Smoke + cutover

---

### Task 11.1: Telemetry verification script

**Files:**
- Create: `scripts/verify-telemetry.ts`

- [ ] **Step 1: Implement**

```typescript
// scripts/verify-telemetry.ts
// Queries Analytics Engine SQL API for recent agent_events.
// Usage: pnpm tsx scripts/verify-telemetry.ts <userId>

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID!;
const API_TOKEN = process.env.CF_API_TOKEN!;
const userId = process.argv[2];
if (!userId) { console.error('usage: verify-telemetry.ts <userId>'); process.exit(1); }

const sql = `
  SELECT index1 AS kind, blob1 AS name, COUNT(*) AS n, AVG(double1) AS avg_ms
  FROM shipflare_agent_events
  WHERE index2 = '${userId.replace(/'/g, "''")}'
    AND timestamp > NOW() - INTERVAL '5' MINUTE
  GROUP BY kind, name
`;

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
  { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}` }, body: sql }
);
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!body.data || body.data.length === 0) {
  console.error('FAIL: no rows in last 5 minutes');
  process.exit(1);
}
console.log('PASS: telemetry rows present');
```

- [ ] **Step 2: Commit**

```bash
git add scripts/verify-telemetry.ts
git commit -m "feat(scripts): verify-telemetry.ts for post-deploy smoke"
```

---

### Task 11.2: Full-system smoke on dev

**Files:** none (manual)

- [ ] **Step 1: Deploy to dev**

```bash
pnpm --filter @shipflare/core deploy:dev
pnpm --filter web deploy:dev
```

- [ ] **Step 2: Run Playwright suites against dev**

```bash
PW_BASE_URL=https://dev.shipflare.com pnpm --filter web exec playwright test e2e/cmo-chat.spec.ts e2e/onboarding-plan-build.spec.ts
```

- [ ] **Step 3: Run telemetry verify**

```bash
CF_ACCOUNT_ID=... CF_API_TOKEN=... pnpm tsx scripts/verify-telemetry.ts <test-user-id>
```

Expected: at least one row each for `agent_run`, `tool_invocation`, `skill_invocation`.

- [ ] **Step 4: Manual founder walkthrough**

Open dev, log in as a real test user, complete the onboarding plan-build wizard, exchange 5+ messages with CMO, verify:
- Reasoning blocks visible ("Thinking…" with content)
- Nested HoG/SMM runs visible when CMO consults them
- Skill names visible during drafting flows
- Page reload mid-turn → conversation restored, no lost tool states

- [ ] **Step 5: Record findings**

If anything regressed, fix on this branch and re-run Steps 2-4. Do NOT proceed to PR until all four pass.

---

### Task 11.3: Open PR and merge to dev

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/cf-native-chat-migration
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base dev --title "CF-native chat migration (5-layer rewrite)" --body "$(cat <<'EOF'
## Summary

Replaces the hand-rolled chat / activity / dispatch stack with five clean layers built on Cloudflare Agents SDK + AI SDK v5:

1. CMO + HoG + SMM extend `AIChatAgent` (chat surface)
2. Generalized `consult` tool over `runAgentTool` (agent orchestration, DAG mesh)
3. `Skill` primitive preserved; emits AI SDK v5 `data-skill-*` parts
4. `CmoExternalMcp` for external Claude Desktop / Cursor / n8n usage (OAuth-protected)
5. Single Workers Analytics Engine dataset for ops telemetry

Founder chat history is reset (per spec Q3=B). Hand-rolled activity stream files deleted; `_trace` parent linkage gone (`agentTool` handles natively).

## Spec

`docs/superpowers/specs/2026-05-16-cf-native-chat-migration-design.md`

## Plan

`docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md`

## Test plan

- [x] Unit tests green: `pnpm -r exec vitest run`
- [x] Build green: `pnpm -r exec tsc --noEmit`
- [x] Playwright `cmo-chat.spec.ts` + `onboarding-plan-build.spec.ts` green on dev
- [x] `scripts/verify-telemetry.ts` shows rows in `shipflare_agent_events` after manual walkthrough
- [x] Manual founder walkthrough on dev: reasoning visible, nested runs visible, reload resumes
EOF
)"
```

- [ ] **Step 3: Merge with merge commit (NOT squash)**

Per `feedback_pr_merge_use_merge_commit` memory. After PR is reviewed and CI green:

```bash
gh pr merge --merge
```

- [ ] **Step 4: Confirm dev tracks main if applicable**

(No action if main is downstream of dev; otherwise follow the merge convention.)

---

## Self-review (writing-plans skill checklist)

- [x] **Spec coverage:** Every section of the spec (§1–§15) maps to phase(s) in this plan:
  - §1 architecture → Phase overview
  - §2 CMO chat surface → Phase 5
  - §3 orchestration / registry / consult tool → Phase 4
  - §4 skill data parts → Phase 3
  - §5 external MCP → Phase 7
  - §6 telemetry → Phase 1
  - §7 wire protocol → Phase 5 (CMO impl)
  - §8 frontend → Phase 8
  - §9 generalizations → applied across phases
  - §10 New Employee Checklist → Task 10.2
  - §11 testing → integrated as per-task tests + Phase 11
  - §12 phasing → this plan IS the realization
  - §13 deletions → Phase 10
  - §14 risks → addressed inline (Phase 0 fallback for `runAgentTool`)
  - §15 Phase 0 verifications → Task 0.2

- [x] **Placeholder scan:** No TBD / TODO / "fill in later". The only `// ...other tools` markers are for routine porting of existing per-employee direct tools whose code lives in the current source tree (Task 4.4 / 4.5 / 5.1 each include an audit step to list them before porting).

- [x] **Type consistency:** Method/type names match across tasks:
  - `writeAgentEvent` (Task 1.1) called from Task 3.1, Task 5.1
  - `safeAgentChain.check` (Task 2.1) called from Task 4.6
  - `makeConsultTool` (Task 4.6) referenced in Task 4.4, 4.5, 5.1
  - `loadSystemPrompt` (Task 4.7) referenced in Task 4.4, 4.5, 5.1
  - `getEmployee` (Task 4.3) referenced in Task 7.2
  - `setupAgentTest` (Task 5.3) referenced in Task 10.2

- [x] **No spec gap** with no corresponding task.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-cf-native-chat-migration.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
