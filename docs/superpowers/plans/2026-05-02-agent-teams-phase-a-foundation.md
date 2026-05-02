# Agent Teams — Phase A: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four-layer tool filter pipeline + `assembleToolPool` single source of truth + AgentDefinition full frontmatter (restored `disallowedTools`/`background`, new `role`/`requires`), with **zero observable behavior change** to any existing flow.

**Architecture:** Add the engine PDF §3.5.1 invariant ("same tool pool, different views via `assembleToolPool`") as new infrastructure modules in `src/tools/AgentTool/`. Tag the 4 existing built-in agents with their roles. Refactor `spawn.resolveAgentTools` to delegate through `assembleToolPool` while producing the identical tool subset it produces today.

**Tech Stack:** TypeScript 5, Vitest, Zod, Drizzle (no DB changes in Phase A).

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase A.

**Phase A non-goals:** No new tools (TaskStop / Sleep / SyntheticOutput land in Phases B/C/D). No DB migration. No async lifecycle. No AGENT.md content rewrites — only frontmatter additions.

---

## File structure

**New files (4):**

| Path | Responsibility |
|---|---|
| `src/tools/AgentTool/role-tools.ts` | Per-role whitelists (`ROLE_WHITELISTS`); declared as `Set<string>` because the four-layer filter pipeline needs O(1) membership checks |
| `src/tools/AgentTool/blacklists.ts` | Per-role blacklists (`INTERNAL_TEAMMATE_TOOLS` / `INTERNAL_SUBAGENT_TOOLS`); architecture-level invariants enforced by tool-name presence |
| `src/tools/AgentTool/assemble-tool-pool.ts` | The SSOT function `assembleToolPool(role, def, ctx)`. Used by both runtime tool filtering AND the team-lead's user-context injection text — same constants, no drift |
| `src/tools/AgentTool/requires-resolver.ts` | Resolves `requires:` DSL strings (`channel:x`, `product:has_description`) to booleans against current team / product state |

**Modified files (7):**

| Path | What changes |
|---|---|
| `src/tools/AgentTool/loader.ts` | Add `disallowedTools` / `background` / `role` / `requires` to schema; remove from `DROPPED_FIELDS`; populate new `AgentDefinition` fields with safe defaults; add `source: 'built-in'` |
| `src/tools/AgentTool/spawn.ts` | Refactor `resolveAgentTools(def)` to call `assembleToolPool(def.role, def, ctx)` and produce the same result it does today |
| `src/tools/AgentTool/agents/coordinator/AGENT.md` | Add `role: lead` to frontmatter |
| `src/tools/AgentTool/agents/content-manager/AGENT.md` | Add `role: member` |
| `src/tools/AgentTool/agents/content-planner/AGENT.md` | Add `role: member` |
| `src/tools/AgentTool/agents/discovery-agent/AGENT.md` | Add `role: member` and a representative `requires:` block |
| `src/tools/registry.ts` | Add `getAllToolNames()` helper if not already exposed (used by `assembleToolPool`) |

**New tests (4):**

| Path | What it covers |
|---|---|
| `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` | `disallowedTools` / `background` / `role` / `requires` parse correctly; defaults apply when absent; invalid values rejected |
| `src/tools/AgentTool/__tests__/role-tools.test.ts` | `ROLE_WHITELISTS` shape and contents per role |
| `src/tools/AgentTool/__tests__/blacklists.test.ts` | `INTERNAL_TEAMMATE_TOOLS` contains `Task`; reserved future-tool names documented as comments |
| `src/tools/AgentTool/__tests__/requires-resolver.test.ts` | DSL parsing for `channel:x`, `product:has_description`; unknown prefixes throw |
| `src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts` | Given role + AgentDefinition + registry → expected tool set; SSOT property: text injection ≡ runtime filter |
| `src/tools/AgentTool/__tests__/four-layer-filter.test.ts` | Integration: load real AGENT.md, run `assembleToolPool`, verify final set is what spawn used to produce |

**New test fixtures (1):**

| Path | Purpose |
|---|---|
| `src/tools/AgentTool/__tests__/fixtures/full-frontmatter-agent/AGENT.md` | Exercises every restored / new field at once |

---

## Sequence + dependencies

```
Task 1 (loader: disallowedTools)   ──┐
Task 2 (loader: background)        ──┤
Task 3 (loader: role)              ──┼──▶ Task 12 (AGENT.md tagging)
Task 4 (loader: requires)          ──┤
Task 5 (loader: source field)      ──┘
Task 6 (registry getAllToolNames)
Task 7 (role-tools.ts)             ──┐
Task 8 (blacklists.ts)             ──┼──▶ Task 10 (assemble-tool-pool) ──▶ Task 11 (spawn refactor) ──▶ Task 13 (verification gate)
Task 9 (requires-resolver.ts)      ──┘
```

---

## Task 1: Loader — restore `disallowedTools` field

**Files:**
- Modify: `src/tools/AgentTool/loader.ts:48-86` (schema + DROPPED_FIELDS), `loader.ts:18-30` (AgentDefinition interface), `loader.ts:429-440` (return shape)
- Test: `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` (NEW)
- Fixture: `src/tools/AgentTool/__tests__/fixtures/full-frontmatter-agent/AGENT.md` (NEW)

- [ ] **Step 1: Create the test fixture**

Create `src/tools/AgentTool/__tests__/fixtures/full-frontmatter-agent/AGENT.md`:

```markdown
---
name: full-frontmatter-agent
description: Fixture exercising every restored / new Agent Teams frontmatter field (disallowedTools, background, role, requires) on a single agent.
model: claude-sonnet-4-6
maxTurns: 25
tools:
  - Task
  - SendMessage
  - query_plan_items
disallowedTools:
  - SendMessage
background: true
role: member
requires:
  - channel:x
  - product:has_description
---

# Full frontmatter agent

This agent exists only to verify the loader produces the expected shape
when every Phase A field is present.
```

- [ ] **Step 2: Write the failing test**

Create `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgent } from '@/tools/AgentTool/loader';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('loader — Phase A restored fields', () => {
  it('parses disallowedTools as a string array', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    expect(agent.disallowedTools).toEqual(['SendMessage']);
  });

  it('defaults disallowedTools to [] when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.disallowedTools).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test — verify it fails**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: FAIL with `Property 'disallowedTools' does not exist on type 'AgentDefinition'` (TypeScript error) OR `expect(received).toEqual(expected) — received: undefined`.

- [ ] **Step 4: Update the AgentDefinition interface**

In `src/tools/AgentTool/loader.ts`, around line 18-30, change the interface:

```ts
export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];   // NEW — Phase A
  skills: string[];
  model?: string;
  maxTurns: number;
  color?: string;
  /** Markdown body + inlined references + inlined shared-references. */
  systemPrompt: string;
  /** Absolute path to the AGENT.md file that produced this definition. */
  sourcePath: string;
}
```

- [ ] **Step 5: Update the frontmatter Zod schema**

In `loader.ts` around line 48-68, add to the `frontmatterSchema.object({...})`:

```ts
    disallowedTools: z.array(z.string()).optional(),
```

- [ ] **Step 6: Remove `disallowedTools` from `DROPPED_FIELDS`**

In `loader.ts` around line 73-85, the new list:

```ts
const DROPPED_FIELDS = [
  'hooks',
  'mcpServers',
  'permissionMode',
  'isolation',
  'initialPrompt',
  'memory',
  'omitClaudeMd',
  'requiredMcpServers',
  'effort',
  // disallowedTools restored Phase A — see Agent Teams spec §5
] as const;
```

- [ ] **Step 7: Wire the field into the loader return shape**

In `loader.ts`, the `return` block at line 429-440:

```ts
  return {
    name: parsed.name,
    description: parsed.description,
    tools: parsed.tools ?? [],
    disallowedTools: parsed.disallowedTools ?? [],
    skills: parsed.skills ?? [],
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    maxTurns: parsed.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(parsed.color !== undefined ? { color: parsed.color } : {}),
    systemPrompt,
    sourcePath: agentMdPath,
  };
```

- [ ] **Step 8: Run the test — verify it passes**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run all loader tests for regression**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader.test.ts
```

Expected: PASS (no regression — the new field has a `[]` default).

- [ ] **Step 10: Run typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors.

- [ ] **Step 11: Commit**

```bash
git add src/tools/AgentTool/loader.ts \
        src/tools/AgentTool/__tests__/loader-restore-fields.test.ts \
        src/tools/AgentTool/__tests__/fixtures/full-frontmatter-agent/
git commit -m "feat(AgentTool/loader): restore disallowedTools frontmatter (Phase A)"
```

---

## Task 2: Loader — restore `background` field

**Files:**
- Modify: `src/tools/AgentTool/loader.ts` (schema + interface + return + DROPPED_FIELDS)
- Test: `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append to `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` inside the `describe`:

```ts
  it('parses background as a boolean', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    expect(agent.background).toBe(true);
  });

  it('defaults background to false when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.background).toBe(false);
  });
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: FAIL on `background` undefined.

- [ ] **Step 3: Update interface**

In `src/tools/AgentTool/loader.ts` `AgentDefinition`:

```ts
  background: boolean;        // NEW — Phase A; semantics adapted (see spec §5)
```

- [ ] **Step 4: Update Zod schema**

```ts
    background: z.boolean().optional(),
```

- [ ] **Step 5: Update `DROPPED_FIELDS`**

Remove `'background'` from the list (it should already be absent if you compare against Task 1 — verify and confirm).

- [ ] **Step 6: Update return shape**

```ts
    background: parsed.background ?? false,
```

- [ ] **Step 7: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: PASS.

- [ ] **Step 8: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

- [ ] **Step 9: Commit**

```bash
git add src/tools/AgentTool/loader.ts \
        src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
git commit -m "feat(AgentTool/loader): restore background frontmatter (Phase A)"
```

---

## Task 3: Loader — add `role` field with default

**Files:**
- Modify: `src/tools/AgentTool/loader.ts`
- Test: `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` (extend)

- [ ] **Step 1: Add the failing tests**

Append to `loader-restore-fields.test.ts`:

```ts
  it('parses role: lead', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    // The fixture sets role: member — assert that explicitly
    expect(agent.role).toBe('member');
  });

  it('defaults role to "member" when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.role).toBe('member');
  });

  it('rejects an invalid role value', async () => {
    // Inline fixture — write a temp file (or use fs/promises) is fine,
    // but simplest is to create a fixtures/invalid-role/AGENT.md
    await expect(
      loadAgent(path.join(FIXTURES, 'invalid-role'), {
        sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
      }),
    ).rejects.toThrow(/role/i);
  });
```

- [ ] **Step 2: Create the invalid-role fixture**

Create `src/tools/AgentTool/__tests__/fixtures/invalid-role/AGENT.md`:

```markdown
---
name: invalid-role
description: Fixture used to verify the loader rejects unknown role values.
role: superadmin
tools: []
---

# Body
```

- [ ] **Step 3: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: 3 failures (`role` undefined; default missing; invalid not rejected).

- [ ] **Step 4: Update interface**

In `loader.ts`:

```ts
export type AgentRole = 'lead' | 'member';

export interface AgentDefinition {
  // ... existing fields ...
  role: AgentRole;            // NEW — Phase A
}
```

- [ ] **Step 5: Update Zod schema**

```ts
    role: z.enum(['lead', 'member']).optional(),
```

- [ ] **Step 6: Update return shape**

```ts
    role: parsed.role ?? 'member',
```

- [ ] **Step 7: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: 3 new tests PASS (Zod's `enum` rejection is the source of the "role" error string).

- [ ] **Step 8: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

- [ ] **Step 9: Commit**

```bash
git add src/tools/AgentTool/loader.ts \
        src/tools/AgentTool/__tests__/loader-restore-fields.test.ts \
        src/tools/AgentTool/__tests__/fixtures/invalid-role/
git commit -m "feat(AgentTool/loader): add role frontmatter (lead/member, default member)"
```

---

## Task 4: Loader — add `requires` field

**Files:**
- Modify: `src/tools/AgentTool/loader.ts`
- Test: `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

```ts
  it('parses requires as a string array', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    expect(agent.requires).toEqual(['channel:x', 'product:has_description']);
  });

  it('defaults requires to [] when absent', async () => {
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: path.join(FIXTURES, '_shared', 'references'),
    });
    expect(agent.requires).toEqual([]);
  });
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: 2 failures.

- [ ] **Step 3: Update interface**

```ts
  requires: string[];         // NEW — Phase A; DSL: 'channel:x', 'product:has_description'
```

- [ ] **Step 4: Update Zod schema**

```ts
    requires: z.array(z.string()).optional(),
```

- [ ] **Step 5: Update return shape**

```ts
    requires: parsed.requires ?? [],
```

- [ ] **Step 6: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/loader.ts \
        src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
git commit -m "feat(AgentTool/loader): add requires frontmatter (channel: / product: DSL)"
```

---

## Task 5: AgentDefinition discriminated union — add `source` field

**Files:**
- Modify: `src/tools/AgentTool/loader.ts`
- Test: `src/tools/AgentTool/__tests__/loader-restore-fields.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

```ts
  it('marks loader-produced agents with source: "built-in"', async () => {
    const agent = await loadAgent(
      path.join(FIXTURES, 'full-frontmatter-agent'),
      { sharedReferencesDir: path.join(FIXTURES, '_shared', 'references') },
    );
    expect(agent.source).toBe('built-in');
  });
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: FAIL — `source` undefined.

- [ ] **Step 3: Refactor the AgentDefinition shape into a discriminated union**

In `loader.ts`, replace the existing `interface AgentDefinition`:

```ts
export type AgentRole = 'lead' | 'member';

interface BaseAgentDefinition {
  name: string;
  description: string;
  role: AgentRole;
  tools: string[];
  disallowedTools: string[];
  skills: string[];
  requires: string[];
  background: boolean;
  model?: string;
  maxTurns: number;
  color?: string;
  systemPrompt: string;
}

export interface BuiltInAgentDefinition extends BaseAgentDefinition {
  source: 'built-in';
  sourcePath: string;
}

// Declared now (Phase A) so the discriminated union compiles cleanly;
// the loader path that produces this lands in Phase 2+ when DB-stored
// custom agents become user-facing.
export interface CustomAgentDefinition extends BaseAgentDefinition {
  source: 'custom';
  ownerId: string;
  storedAt: 'db';
}

export type AgentDefinition = BuiltInAgentDefinition | CustomAgentDefinition;
```

- [ ] **Step 4: Wire `source: 'built-in'` into the return shape**

In `loader.ts`'s return block:

```ts
  return {
    source: 'built-in' as const,
    name: parsed.name,
    description: parsed.description,
    role: parsed.role ?? 'member',
    tools: parsed.tools ?? [],
    disallowedTools: parsed.disallowedTools ?? [],
    skills: parsed.skills ?? [],
    requires: parsed.requires ?? [],
    background: parsed.background ?? false,
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    maxTurns: parsed.maxTurns ?? DEFAULT_MAX_TURNS,
    ...(parsed.color !== undefined ? { color: parsed.color } : {}),
    systemPrompt,
    sourcePath: agentMdPath,
  };
```

- [ ] **Step 5: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck and full AgentTool tests**

```bash
pnpm tsc --noEmit --pretty false
pnpm vitest run src/tools/AgentTool
```

Expected: zero TS errors; all loader / spawn / Task tests still PASS (existing call sites that read `agent.name` etc. are unaffected by the discriminated union).

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/loader.ts \
        src/tools/AgentTool/__tests__/loader-restore-fields.test.ts
git commit -m "refactor(AgentTool): AgentDefinition → BuiltIn|Custom discriminated union"
```

---

## Task 6: Registry — expose `getAllToolNames()` helper

**Files:**
- Modify: `src/core/tool-system.ts:82` (`ToolRegistry` class)
- Test: extend an existing tool-system test, or create `src/core/__tests__/tool-system.test.ts` if none

- [ ] **Step 1: Check whether a helper already exists**

```bash
grep -n "getAllToolNames\|listNames\|allNames" src/core/tool-system.ts
```

If it exists, skip to Task 7.

- [ ] **Step 2: Write failing test**

If `src/core/__tests__/tool-system.test.ts` doesn't exist, create it with:

```ts
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/core/tool-system';

describe('ToolRegistry.getAllToolNames', () => {
  it('returns the registered tool names', () => {
    const reg = new ToolRegistry();
    reg.register({ name: 'A', /* ...satisfies AnyToolDefinition stub... */ } as never);
    reg.register({ name: 'B' } as never);
    expect(new Set(reg.getAllToolNames())).toEqual(new Set(['A', 'B']));
  });
});
```

If a similar test file exists, append the test there instead.

- [ ] **Step 3: Run — verify failure**

```bash
pnpm vitest run src/core/__tests__/tool-system.test.ts
```

Expected: FAIL — `getAllToolNames is not a function`.

- [ ] **Step 4: Add the method to `ToolRegistry`**

In `src/core/tool-system.ts` after the `getAll()` method around line 102-104:

```ts
  /** Return just the names of registered tools (Set-friendly for filter pipelines). */
  getAllToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
```

- [ ] **Step 5: Run — verify pass**

```bash
pnpm vitest run src/core/__tests__/tool-system.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/core/tool-system.ts src/core/__tests__/tool-system.test.ts
git commit -m "feat(ToolRegistry): add getAllToolNames() for assemble-tool-pool"
```

---

## Task 7: New file — `role-tools.ts` (per-role whitelists)

**Files:**
- Create: `src/tools/AgentTool/role-tools.ts`
- Test: `src/tools/AgentTool/__tests__/role-tools.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `src/tools/AgentTool/__tests__/role-tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  getRoleWhitelist,
  TEAM_LEAD_ALLOWED_TOOLS,
  TEAMMATE_ALLOWED_TOOLS,
  SUBAGENT_ALLOWED_TOOLS,
  type AgentRole,
} from '@/tools/AgentTool/role-tools';

describe('role-tools — Phase A whitelists', () => {
  it('exposes a Set per role', () => {
    expect(TEAM_LEAD_ALLOWED_TOOLS).toBeInstanceOf(Set);
    expect(TEAMMATE_ALLOWED_TOOLS).toBeInstanceOf(Set);
    expect(SUBAGENT_ALLOWED_TOOLS).toBeInstanceOf(Set);
  });

  it('Phase A: all whitelists are "any registered tool" (use blacklist to subtract)', () => {
    // Phase A keeps the whitelists permissive — narrowing happens in
    // Phase B/C/D when SendMessage / Sleep / TaskStop add per-role
    // distinctions. The blacklist is the only narrowing source today.
    expect(TEAM_LEAD_ALLOWED_TOOLS.has('*')).toBe(true);
    expect(TEAMMATE_ALLOWED_TOOLS.has('*')).toBe(true);
    expect(SUBAGENT_ALLOWED_TOOLS.has('*')).toBe(true);
  });

  it('getRoleWhitelist resolves by role', () => {
    const lead: AgentRole = 'lead';
    const member: AgentRole = 'member';
    expect(getRoleWhitelist(lead)).toBe(TEAM_LEAD_ALLOWED_TOOLS);
    expect(getRoleWhitelist(member)).toBe(TEAMMATE_ALLOWED_TOOLS);
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/role-tools.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `role-tools.ts`**

Create `src/tools/AgentTool/role-tools.ts`:

```ts
// Per-role tool WHITELISTS — layer ② of the four-layer filter pipeline
// (engine PDF §3.5.1). Used by `assembleToolPool`.
//
// Phase A: all roles permit '*' (any registered tool). Narrowing happens
// today via layer ③ (blacklists) and layer ④ (AgentDefinition.tools).
// Phase B/C/D introduce role-specific narrowing as new tools (TaskStop,
// Sleep) come online and need per-role gating.

import type { AgentRole } from './loader';

/** Sentinel meaning "any registered tool name passes layer ②". */
export const ALL_TOOLS = '*' as const;

export const TEAM_LEAD_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ALL_TOOLS,
]);

export const TEAMMATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ALL_TOOLS,
]);

export const SUBAGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ALL_TOOLS,
]);

export function getRoleWhitelist(role: AgentRole): ReadonlySet<string> {
  switch (role) {
    case 'lead':
      return TEAM_LEAD_ALLOWED_TOOLS;
    case 'member':
      return TEAMMATE_ALLOWED_TOOLS;
  }
}

export type { AgentRole };
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/role-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/role-tools.ts \
        src/tools/AgentTool/__tests__/role-tools.test.ts
git commit -m "feat(AgentTool): role-tools.ts — layer ② whitelists per role"
```

---

## Task 8: New file — `blacklists.ts` (architecture-level invariants)

**Files:**
- Create: `src/tools/AgentTool/blacklists.ts`
- Test: `src/tools/AgentTool/__tests__/blacklists.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `src/tools/AgentTool/__tests__/blacklists.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  INTERNAL_TEAMMATE_TOOLS,
  INTERNAL_SUBAGENT_TOOLS,
  getRoleBlacklist,
} from '@/tools/AgentTool/blacklists';
import { TASK_TOOL_NAME } from '@/tools/AgentTool/AgentTool';
import { SEND_MESSAGE_TOOL_NAME } from '@/tools/SendMessageTool/SendMessageTool';

describe('blacklists — Phase A', () => {
  it('forbids teammate from spawning sync subagents (Task)', () => {
    expect(INTERNAL_TEAMMATE_TOOLS.has(TASK_TOOL_NAME)).toBe(true);
  });

  it('subagent inherits teammate blacklist + cannot SendMessage', () => {
    for (const t of INTERNAL_TEAMMATE_TOOLS) {
      expect(INTERNAL_SUBAGENT_TOOLS.has(t)).toBe(true);
    }
    expect(INTERNAL_SUBAGENT_TOOLS.has(SEND_MESSAGE_TOOL_NAME)).toBe(true);
  });

  it('lead has empty blacklist (lead is the policy boundary, not the policed)', () => {
    const leadBL = getRoleBlacklist('lead');
    expect(leadBL.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/blacklists.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `blacklists.ts`**

Create `src/tools/AgentTool/blacklists.ts`:

```ts
// Per-role tool BLACKLISTS — layer ③ of the four-layer filter pipeline
// (engine PDF §3.5.1). Used by `assembleToolPool`.
//
// These enforce ARCHITECTURE-LEVEL invariants — not domain limits.
// Removing TASK_TOOL_NAME from INTERNAL_TEAMMATE_TOOLS, for instance,
// allows teammates to spawn sub-subagents, breaking the "single
// coordinator" invariant. Such removals are review-rejects.
//
// Phase A scope: only tools that exist today are present. Reserved
// future blacklist entries (TaskStop, TeamCreate, TeamDelete,
// SyntheticOutput) are added in their respective Phase B/C/D landings.

import { TASK_TOOL_NAME } from './AgentTool';
import { SEND_MESSAGE_TOOL_NAME } from '@/tools/SendMessageTool/SendMessageTool';
import type { AgentRole } from './loader';

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Tools no `member` may use — protects "single-direction, tree-shaped
 * coordination" (engine PDF §3.5.2).
 *
 * Phase A members: { Task }.
 * Phase B+ adds: TaskStop, TeamCreate, TeamDelete, SyntheticOutput.
 */
export const INTERNAL_TEAMMATE_TOOLS: ReadonlySet<string> = new Set([
  TASK_TOOL_NAME,
]);

/**
 * Sync subagents (mode-2) inherit the teammate blacklist and additionally
 * lose `SendMessage` — they must complete in their turn without
 * initiating further coordination.
 *
 * Phase A subagents: teammate blacklist + { SendMessage }.
 * Phase D adds: Sleep (subagents cannot yield mid-turn).
 */
export const INTERNAL_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  ...INTERNAL_TEAMMATE_TOOLS,
  SEND_MESSAGE_TOOL_NAME,
]);

export function getRoleBlacklist(role: AgentRole): ReadonlySet<string> {
  switch (role) {
    case 'lead':
      return EMPTY_SET;
    case 'member':
      return INTERNAL_TEAMMATE_TOOLS;
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/blacklists.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/blacklists.ts \
        src/tools/AgentTool/__tests__/blacklists.test.ts
git commit -m "feat(AgentTool): blacklists.ts — layer ③ INTERNAL_TEAMMATE/SUBAGENT_TOOLS"
```

---

## Task 9: New file — `requires-resolver.ts`

**Files:**
- Create: `src/tools/AgentTool/requires-resolver.ts`
- Test: `src/tools/AgentTool/__tests__/requires-resolver.test.ts` (NEW)

**Note:** Phase A only ships the parser + the boolean evaluator with
in-memory state injection (so tests don't hit the DB). Wiring the
real `channels` / `products` queries is Phase B work — but the public
API lands now so Phase B can swap implementations without touching
callers.

- [ ] **Step 1: Write the failing test**

Create `src/tools/AgentTool/__tests__/requires-resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseRequirement,
  evaluateRequirement,
  evaluateAllRequirements,
  type TeamFacts,
} from '@/tools/AgentTool/requires-resolver';

describe('parseRequirement', () => {
  it('parses channel:x', () => {
    expect(parseRequirement('channel:x')).toEqual({
      kind: 'channel',
      value: 'x',
    });
  });

  it('parses product:has_description', () => {
    expect(parseRequirement('product:has_description')).toEqual({
      kind: 'product',
      value: 'has_description',
    });
  });

  it('throws on unknown prefix', () => {
    expect(() => parseRequirement('bogus:foo')).toThrow(
      /unknown.*prefix.*bogus/i,
    );
  });

  it('throws on missing colon', () => {
    expect(() => parseRequirement('channelx')).toThrow(/missing.*colon/i);
  });
});

describe('evaluateRequirement', () => {
  const facts: TeamFacts = {
    channels: new Set(['x', 'reddit']),
    productHasDescription: true,
  };

  it('channel:x → true when present', () => {
    expect(evaluateRequirement(parseRequirement('channel:x'), facts)).toBe(true);
  });

  it('channel:linkedin → false when absent', () => {
    expect(evaluateRequirement(parseRequirement('channel:linkedin'), facts)).toBe(
      false,
    );
  });

  it('product:has_description → true when set', () => {
    expect(
      evaluateRequirement(parseRequirement('product:has_description'), facts),
    ).toBe(true);
  });

  it('product:unknown_predicate → throws', () => {
    expect(() =>
      evaluateRequirement(parseRequirement('product:unknown_predicate'), facts),
    ).toThrow(/unknown.*product.*predicate/i);
  });
});

describe('evaluateAllRequirements', () => {
  const facts: TeamFacts = {
    channels: new Set(['x']),
    productHasDescription: true,
  };

  it('returns true when every requirement passes', () => {
    expect(
      evaluateAllRequirements(['channel:x', 'product:has_description'], facts),
    ).toBe(true);
  });

  it('returns false when any requirement fails', () => {
    expect(
      evaluateAllRequirements(['channel:x', 'channel:reddit'], facts),
    ).toBe(false);
  });

  it('returns true on empty requires list', () => {
    expect(evaluateAllRequirements([], facts)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/requires-resolver.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `requires-resolver.ts`**

Create `src/tools/AgentTool/requires-resolver.ts`:

```ts
// Resolves AgentDefinition `requires:` DSL strings against current team /
// product state. Today the DSL is intentionally narrow:
//   - `channel:<id>`              — connected platform (x, reddit, ...)
//   - `product:has_description`   — products.description IS NOT NULL
//
// Phase A: parser + evaluator with TeamFacts injection (no DB access).
// Phase B/E will add a DB-backed fact loader and use this in dynamic
// team-roster injection.

export type Requirement =
  | { kind: 'channel'; value: string }
  | { kind: 'product'; value: string };

/** In-memory snapshot of team / product facts the resolver evaluates against. */
export interface TeamFacts {
  /** Connected channel ids (set of platform identifiers, e.g. 'x', 'reddit'). */
  channels: ReadonlySet<string>;
  /** True when the team's product has a non-empty description. */
  productHasDescription: boolean;
}

const KNOWN_KINDS = new Set(['channel', 'product']);

export function parseRequirement(raw: string): Requirement {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    throw new Error(`requires entry "${raw}" is missing a colon (expected "kind:value")`);
  }
  const kind = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!KNOWN_KINDS.has(kind)) {
    throw new Error(
      `requires entry "${raw}" has unknown prefix "${kind}" (expected one of: ${Array.from(KNOWN_KINDS).join(', ')})`,
    );
  }
  return { kind: kind as Requirement['kind'], value };
}

export function evaluateRequirement(req: Requirement, facts: TeamFacts): boolean {
  switch (req.kind) {
    case 'channel':
      return facts.channels.has(req.value);
    case 'product':
      if (req.value === 'has_description') return facts.productHasDescription;
      throw new Error(`unknown product predicate: "${req.value}"`);
  }
}

export function evaluateAllRequirements(
  requires: readonly string[],
  facts: TeamFacts,
): boolean {
  return requires.every((r) => evaluateRequirement(parseRequirement(r), facts));
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/requires-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/requires-resolver.ts \
        src/tools/AgentTool/__tests__/requires-resolver.test.ts
git commit -m "feat(AgentTool): requires-resolver.ts — channel:/product: DSL evaluator"
```

---

## Task 10: New file — `assemble-tool-pool.ts` (the SSOT)

**Files:**
- Create: `src/tools/AgentTool/assemble-tool-pool.ts`
- Test: `src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/core/tool-system';
import { assembleToolPool } from '@/tools/AgentTool/assemble-tool-pool';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import type { AnyToolDefinition } from '@/core/types';

function fakeTool(name: string): AnyToolDefinition {
  return { name } as AnyToolDefinition;
}

function fakeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    source: 'built-in',
    sourcePath: '/test/AGENT.md',
    name: 'fake',
    description: 'fake agent',
    role: 'member',
    tools: [],
    disallowedTools: [],
    skills: [],
    requires: [],
    background: false,
    maxTurns: 10,
    systemPrompt: '',
    ...over,
  };
}

describe('assembleToolPool — SSOT four-layer filter', () => {
  it('layer ④: respects AgentDefinition.tools allow-list', () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    reg.register(fakeTool('C'));
    const def = fakeAgent({ tools: ['A', 'C'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['A', 'C']);
  });

  it('layer ④: respects AgentDefinition.disallowedTools subtraction', () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    const def = fakeAgent({ tools: ['A', 'B'], disallowedTools: ['B'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name)).toEqual(['A']);
  });

  it("layer ③: applies INTERNAL_TEAMMATE_TOOLS blacklist for role='member'", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('Task'));
    reg.register(fakeTool('SendMessage'));
    const def = fakeAgent({ tools: ['Task', 'SendMessage'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name)).toEqual(['SendMessage']);
  });

  it("layer ③: lead is unblacklisted — keeps Task", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('Task'));
    reg.register(fakeTool('SendMessage'));
    const def = fakeAgent({ role: 'lead', tools: ['Task', 'SendMessage'] });
    const pool = assembleToolPool('lead', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['SendMessage', 'Task']);
  });

  it("AgentDefinition.tools='*' lets every-non-blacklisted tool through", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    reg.register(fakeTool('Task'));
    const def = fakeAgent({ tools: ['*'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['A', 'B']); // Task blacklisted
  });

  it('SSOT property: getInjectionTextNames(role, def) === pool tool names', () => {
    // The user-context injection text the team-lead sees about its
    // teammates' tools must equal the actual runtime filter result —
    // engine PDF §3.5.1 invariant ("the spec text is computed from the
    // same constants as the runtime filter, so they cannot drift").
    const reg = new ToolRegistry();
    reg.register(fakeTool('Task'));
    reg.register(fakeTool('SendMessage'));
    reg.register(fakeTool('query_plan_items'));
    const def = fakeAgent({
      tools: ['Task', 'SendMessage', 'query_plan_items'],
      role: 'member',
    });
    const pool = assembleToolPool('member', def, reg);
    const injected = require('@/tools/AgentTool/assemble-tool-pool').getInjectionTextNames(
      'member',
      def,
      reg,
    );
    expect(injected).toEqual(pool.map((t) => t.name).sort());
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `assemble-tool-pool.ts`**

Create `src/tools/AgentTool/assemble-tool-pool.ts`:

```ts
// Single source of truth for "what tools does agent X see?".
//
// Engine PDF §3.5.1: the user-context injection text shown to the
// team-lead's LLM ("teammates have access to these tools: …") and the
// runtime tool list given to a teammate's runAgent both flow through
// this function. By construction they cannot drift.
//
// Four layers (in order):
//   ① getAllRegisteredTools(registry)
//   ② role whitelist  (role-tools.ts)            — '*' = pass
//   ③ role blacklist  (blacklists.ts)            — set membership
//   ④ AgentDefinition.tools allow-list           — '*' = pass
//      AgentDefinition.disallowedTools subtract

import type { AnyToolDefinition } from '@/core/types';
import type { ToolRegistry } from '@/core/tool-system';
import type { AgentDefinition, AgentRole } from './loader';
import { getRoleWhitelist, ALL_TOOLS } from './role-tools';
import { getRoleBlacklist } from './blacklists';

function passesWhitelist(toolName: string, role: AgentRole): boolean {
  const wl = getRoleWhitelist(role);
  return wl.has(ALL_TOOLS) || wl.has(toolName);
}

function passesBlacklist(toolName: string, role: AgentRole): boolean {
  return !getRoleBlacklist(role).has(toolName);
}

function passesAgentAllow(
  toolName: string,
  agentTools: readonly string[] | '*',
): boolean {
  if (agentTools === '*') return true;
  if (Array.isArray(agentTools) && agentTools.length === 1 && agentTools[0] === '*') {
    return true;
  }
  return (agentTools as readonly string[]).includes(toolName);
}

function passesAgentDisallow(
  toolName: string,
  disallowed: readonly string[],
): boolean {
  return !disallowed.includes(toolName);
}

/**
 * Compute the tool pool that agent `def` should see when running with
 * role `role` against registry `registry`. Pure function — no side
 * effects, deterministic.
 */
export function assembleToolPool(
  role: AgentRole,
  def: AgentDefinition,
  registry: ToolRegistry,
): AnyToolDefinition[] {
  const all = registry.getAll();
  return all.filter((tool) => {
    return (
      passesWhitelist(tool.name, role) &&
      passesBlacklist(tool.name, role) &&
      passesAgentAllow(tool.name, def.tools) &&
      passesAgentDisallow(tool.name, def.disallowedTools)
    );
  });
}

/**
 * Tool names — for use in the team-lead's user-context injection text
 * (engine `getCoordinatorUserContext` L80-93 equivalent). Always sorted
 * for stable prompt-cache hits.
 */
export function getInjectionTextNames(
  role: AgentRole,
  def: AgentDefinition,
  registry: ToolRegistry,
): string[] {
  return assembleToolPool(role, def, registry)
    .map((t) => t.name)
    .sort();
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts
```

Expected: PASS (all 6 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/assemble-tool-pool.ts \
        src/tools/AgentTool/__tests__/assemble-tool-pool.test.ts
git commit -m "feat(AgentTool): assemble-tool-pool.ts — four-layer SSOT filter"
```

---

## Task 11: Refactor `spawn.resolveAgentTools` to delegate through `assembleToolPool`

**Files:**
- Modify: `src/tools/AgentTool/spawn.ts:102-121` (`resolveAgentTools`)
- Test: `src/tools/AgentTool/__tests__/four-layer-filter.test.ts` (NEW — integration)

This is the moment of truth: the SSOT is now used by the actual spawn
path. We assert via tests that the resolved tool set is **identical**
to what spawn produced before the refactor (same names, same order
expectations from existing assertions).

- [ ] **Step 1: Write the integration test BEFORE the refactor**

Create `src/tools/AgentTool/__tests__/four-layer-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgent } from '@/tools/AgentTool/loader';
import { resolveAgentTools } from '@/tools/AgentTool/spawn';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const SHARED_REFS = path.join(FIXTURES, '_shared', 'references');

describe('four-layer filter — spawn.resolveAgentTools delegates to assembleToolPool', () => {
  it('member with tools=[A,SendMessage] → [SendMessage] (A blacklisted as Task)', async () => {
    // Use a fixture that declares { tools: [Task, SendMessage] } and
    // assert Task is filtered out for role=member by INTERNAL_TEAMMATE_TOOLS.
    // Since the existing valid-agent fixture already declares tools:
    //   [Task, query_plan_items, SendMessage]
    // and it has no role (defaults to 'member'), spawn.resolveAgentTools
    // must now return [query_plan_items, SendMessage] — Task removed.
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });
    expect(agent.role).toBe('member');
    const resolved = resolveAgentTools(agent);
    const names = resolved.map((t) => t.name).sort();
    // 'Task' must be gone; the other two pass through (assuming they're
    // registered in the test environment via registry imports).
    expect(names).not.toContain('Task');
    expect(names).toContain('SendMessage');
  });

  it('lead with tools=[Task,SendMessage] → both kept (lead unblacklisted)', async () => {
    // The coordinator AGENT.md (post Task 12) is role: lead. Until then
    // we synthesize a lead-tagged def in the test:
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });
    const leadDef = { ...agent, role: 'lead' as const };
    const resolved = resolveAgentTools(leadDef);
    const names = resolved.map((t) => t.name).sort();
    expect(names).toContain('SendMessage');
    expect(names).toContain('Task');
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/four-layer-filter.test.ts
```

Expected: First test FAILS (current `resolveAgentTools` returns Task because it doesn't apply blacklists). Second test happens to pass (Task is in the allow-list).

- [ ] **Step 3: Refactor `resolveAgentTools` in `spawn.ts`**

In `src/tools/AgentTool/spawn.ts`, replace the entire `resolveAgentTools` function (lines 102-121) with:

```ts
/**
 * Resolve a subagent's tool list via the four-layer filter pipeline
 * (`assembleToolPool`). This is the public spawn entry point; it MUST
 * route through `assembleToolPool` so the team-lead's user-context
 * injection text and the actual runtime tool set cannot drift
 * (engine PDF §3.5.1 invariant).
 *
 * `StructuredOutput` is a synthesized/virtual tool: runAgent appends
 * it at runtime when `outputSchema` is given. AGENT.md files that
 * declare it in `tools: [...]` carry it for documentation; the
 * registry doesn't hold it (see src/tools/registry.ts) so the
 * assemble-tool-pool filter naturally drops it from the resolved
 * concrete-tool list. That's intended — runAgent re-adds it.
 *
 * Behavior change vs pre-Phase-A: members declaring `Task` in their
 * tools list now lose it (architecture-level invariant via
 * INTERNAL_TEAMMATE_TOOLS). No current built-in member declares Task;
 * verified by the new four-layer-filter test against valid-agent
 * fixture.
 */
export function resolveAgentTools(def: AgentDefinition): AnyToolDefinition[] {
  return assembleToolPool(def.role, def, registry);
}
```

You'll need to add the import at the top of `spawn.ts`:

```ts
import { assembleToolPool } from './assemble-tool-pool';
```

And remove the now-unused imports (`STRUCTURED_OUTPUT_TOOL_NAME` may
still be used elsewhere in the file — leave it if so).

- [ ] **Step 4: Run the four-layer test — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/four-layer-filter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run ALL AgentTool tests — verify no regression**

```bash
pnpm vitest run src/tools/AgentTool
```

Expected: every existing test still PASSES. Existing call sites in
`spawn.test.ts` and `Task.test.ts` should keep their assertions valid
because:
- The 4 production AGENT.md files don't declare `Task` (only
  coordinator does; coordinator becomes role='lead' in Task 12, where
  Task is unblacklisted).
- `StructuredOutput` filtering preserves the previous behavior (it's
  not in the registry; assembleToolPool filters via `registry.getAll()`).

**If a test fails:** check whether the failing assertion expects a
tool that's now blacklisted. If so, update the assertion AND the
fixture's `role:` to match the intended scenario; do NOT regress the
blacklist.

- [ ] **Step 6: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/spawn.ts \
        src/tools/AgentTool/__tests__/four-layer-filter.test.ts
git commit -m "refactor(AgentTool/spawn): route resolveAgentTools through assembleToolPool"
```

---

## Task 12: Tag the 4 production AGENT.md files with role + requires

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`
- Modify: `src/tools/AgentTool/agents/content-manager/AGENT.md`
- Modify: `src/tools/AgentTool/agents/content-planner/AGENT.md`
- Modify: `src/tools/AgentTool/agents/discovery-agent/AGENT.md`

This is a frontmatter-only change. No body content changes.

- [ ] **Step 1: Tag coordinator as `role: lead`**

Edit `src/tools/AgentTool/agents/coordinator/AGENT.md`. Find the first
`---` block (frontmatter) and add `role: lead` immediately under
`name:`:

```markdown
---
name: coordinator
description: The founder's AI chief of staff. ...
role: lead
model: claude-sonnet-4-6
maxTurns: 50
tools:
  - Task
  - SendMessage
  - query_team_status
  ...
```

- [ ] **Step 2: Tag content-manager as `role: member`**

Edit `src/tools/AgentTool/agents/content-manager/AGENT.md`:

```markdown
---
name: content-manager
description: Drafts content (replies AND posts) in batches. ...
role: member
model: claude-haiku-4-5-20251001
...
```

- [ ] **Step 3: Tag content-planner as `role: member`**

Same pattern: open `src/tools/AgentTool/agents/content-planner/AGENT.md` and add `role: member` after `name:`.

- [ ] **Step 4: Tag discovery-agent as `role: member` and add a representative `requires:`**

Open `src/tools/AgentTool/agents/discovery-agent/AGENT.md`. Discovery
runs API queries against connected platforms; require at least one
channel be connected:

```markdown
---
name: discovery-agent
description: ...
role: member
requires:
  - product:has_description
...
```

(The exact `requires` set is informed by what discovery actually needs
in production. `product:has_description` is the safe minimum
shipped today; channel-specific requirements get added when the
runtime gating in Phase B/E lands.)

- [ ] **Step 5: Run the loader smoke tests for each agent**

```bash
pnpm vitest run src/tools/AgentTool/agents
```

Expected: all 4 agents' existing loader-smoke tests PASS. The new
`role` field round-trips through the loader cleanly (tested in Task 3).

- [ ] **Step 6: Verify the four-layer filter behavior on real agents**

Add this assertion to `src/tools/AgentTool/__tests__/four-layer-filter.test.ts`:

```ts
  it('coordinator (role=lead) keeps Task; content-manager (role=member) has no Task', async () => {
    const root = path.resolve(__dirname, '../agents');
    const lead = await loadAgent(path.join(root, 'coordinator'));
    const member = await loadAgent(path.join(root, 'content-manager'));
    expect(lead.role).toBe('lead');
    expect(member.role).toBe('member');
    expect(resolveAgentTools(lead).map((t) => t.name)).toContain('Task');
    expect(resolveAgentTools(member).map((t) => t.name)).not.toContain('Task');
  });
```

- [ ] **Step 7: Run — verify pass**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/four-layer-filter.test.ts
```

Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/agents/coordinator/AGENT.md \
        src/tools/AgentTool/agents/content-manager/AGENT.md \
        src/tools/AgentTool/agents/content-planner/AGENT.md \
        src/tools/AgentTool/agents/discovery-agent/AGENT.md \
        src/tools/AgentTool/__tests__/four-layer-filter.test.ts
git commit -m "feat(agents): tag built-in agents with role (lead/member); discovery requires:"
```

---

## Task 13: Final verification gate (no behavior change end-to-end)

**Files:** none (verification only)

- [ ] **Step 1: Run the full TypeScript check**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors.

- [ ] **Step 2: Run every AgentTool test**

```bash
pnpm vitest run src/tools/AgentTool
```

Expected: all PASS — including the existing `loader.test.ts`,
`spawn.test.ts`, `Task.test.ts`, `runtime-preamble.test.ts` plus the
new `loader-restore-fields.test.ts`, `role-tools.test.ts`,
`blacklists.test.ts`, `requires-resolver.test.ts`,
`assemble-tool-pool.test.ts`, `four-layer-filter.test.ts`.

- [ ] **Step 3: Run an existing end-to-end team-run integration test**

```bash
pnpm vitest run src/workers/processors/__tests__/team-run.integration.test.ts
```

Expected: PASS — the coordinator (now role=lead) runs identically to
before because the lead's tools weren't narrowed by the blacklist; the
4 member agents don't declare `Task` so they're also unaffected.

**If a downstream test fails because a member-role agent's expected
tool list dropped `Task`:** that's a real bug in the agent definition,
not in Phase A. Either (a) the agent should be `role: lead` (re-tag
in Task 12), or (b) the test was wrong about that agent having `Task`
in the first place.

- [ ] **Step 4: Spot-check `pnpm test` for any unexpected red**

```bash
pnpm test 2>&1 | tail -40
```

Expected: same number of pass/fail as before this branch's first commit.

- [ ] **Step 5: Tag the milestone commit**

```bash
git log --oneline | head -15
git tag -a phase-a-foundation -m "Agent Teams Phase A — Foundation complete"
```

(Push tag only if remote workflow expects it; otherwise local tag is
sufficient as a marker.)

- [ ] **Step 6: Update the spec progress note**

Append to `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md`,
right after the `## Sizing` table:

```markdown
---

## Implementation status

- **Phase A — Foundation:** landed `<date>` (commit hash `<hash>`).
  All four-layer filter infrastructure in place; behavior unchanged.
```

- [ ] **Step 7: Commit the doc update**

```bash
git add docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "docs(spec): mark Agent Teams Phase A landed"
```

---

## Acceptance criteria (Phase A done = all of these green)

- [ ] `src/tools/AgentTool/loader.ts` parses `disallowedTools`,
  `background`, `role`, `requires` with safe defaults
- [ ] `AgentDefinition` is a discriminated union over `source`
  (`'built-in' | 'custom'`); only `'built-in'` is constructed today
- [ ] `src/tools/AgentTool/role-tools.ts`, `blacklists.ts`,
  `requires-resolver.ts`, `assemble-tool-pool.ts` exist with full
  test coverage (100% function coverage of these 4 files)
- [ ] `INTERNAL_TEAMMATE_TOOLS` contains `TASK_TOOL_NAME`;
  `INTERNAL_SUBAGENT_TOOLS` additionally contains
  `SEND_MESSAGE_TOOL_NAME`
- [ ] `spawn.resolveAgentTools` delegates through `assembleToolPool`;
  no other code path computes "tools for agent X"
- [ ] All 4 production AGENT.md files declare `role:` explicitly;
  `discovery-agent` declares a representative `requires:`
- [ ] `pnpm tsc --noEmit` is clean
- [ ] `pnpm vitest run src/tools/AgentTool` is fully green
- [ ] Existing `team-run` integration test is green (no behavior
  change observable to founder-facing flows)
- [ ] Spec doc has Phase A landed timestamp

---

## Self-review notes

1. **Spec coverage:** Every Phase A row in spec §6 maps to a task above.
   `role-tools.ts` → Task 7. `blacklists.ts` → Task 8.
   `assemble-tool-pool.ts` → Task 10. `loader.ts` extension → Tasks 1-5.
   `agent-schemas.ts` → handled inline in Task 5 (the discriminated union
   lives in `loader.ts` per existing structure; `agent-schemas.ts` is
   the unrelated output-schema registry). `spawn.ts` → Task 11.
   `requires-resolver.ts` → Task 9. 4 AGENT.md files → Task 12. The 3
   new test files → Tasks 7, 8, 10 + the integration test in Task 11
   covers `four-layer-filter.test.ts`. The "loader-restore-fields" test
   spans Tasks 1-5.

2. **Placeholder scan:** No "TBD" / "TODO" / "implement later". Every
   step has actual code or actual commands.

3. **Type consistency:** `AgentRole` is exported from `loader.ts` and
   imported by `role-tools.ts` and `blacklists.ts`. `AgentDefinition`
   is exported from `loader.ts` and imported by `assemble-tool-pool.ts`
   and `spawn.ts`. `ToolRegistry` and `AnyToolDefinition` come from
   `@/core/tool-system` and `@/core/types` respectively.

4. **Behavior-change risk audit:** the only behavior change is
   members lose `Task` even if they declared it. No production member
   agent declares `Task` — verified by reading content-manager,
   content-planner, discovery-agent AGENT.md files. The coordinator
   (which DOES declare `Task`) becomes `role: lead` in Task 12,
   keeping `Task`.

5. **Reserve-blacklist commentary:** `INTERNAL_TEAMMATE_TOOLS` Phase A
   contains only `Task` (existing tool). The other 4 entries from the
   spec (`TaskStop`, `TeamCreate`, `TeamDelete`, `SyntheticOutput`)
   are documented as future additions in `blacklists.ts`'s comment.
   They join the set when their respective tools land in Phase B/C/D.
