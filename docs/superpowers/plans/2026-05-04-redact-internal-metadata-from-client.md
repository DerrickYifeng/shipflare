# Redact Internal Metadata From Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop leaking ShipFlare's multi-agent architecture, AI vendor choices, internal tool names, and proprietary kickoff playbook to any authenticated user via the team API surface, without breaking the founder UI's ability to render activity feeds.

**Architecture:** Single redaction helper applied at the four trust-boundary endpoints (`/api/team/conversations/[id]/messages`, `/api/team/events`, `/api/team/activity`, `/api/team/agent/[agentId]/transcript`). The worker still writes raw `tool_input` / `tool_output` / raw `tool_name` / kickoff `goal` text into `team_messages` because nested agent loops and history reconstruction depend on them; redaction happens on read at the API layer. Tool names map to a 6-bucket semantic taxonomy (`searching`, `drafting`, `reviewing`, `posting`, `planning`, `reading-*`); raw names never reach the browser. Kickoff goals get a `metadata.publicContent` opt-in summary that the redactor swaps in for `content`. Plus three side-fixes: delete a public design-system zip, redact xai-client logs, and tighten the transcript route to not serialize tool-use input blocks.

**Tech Stack:** TypeScript / Next.js App Router 15 / Drizzle ORM / Vitest / Playwright (real-browser smoke). Build gate is `pnpm tsc --noEmit` (vitest uses `isolatedModules` and won't catch all type errors).

---

## File Structure

**New files:**
- `src/lib/team/redact-for-client.ts` — pure functions: `publicToolLabel`, `publicAgentLabel`, `publicSkillLabel`, `redactMetadataForClient`, `redactContentBlocksForClient`, `redactMessageRowForClient`. Pure data transforms; no DB calls; no I/O.
- `src/lib/team/__tests__/redact-for-client.test.ts` — vitest unit tests covering every label-map entry, fallback behavior, and edge cases (null metadata, unknown tool names, content-block arrays with nested tool_use blocks).
- `src/workers/processors/lib/agent-run-history-for-client.ts` — `loadAgentRunHistoryRedactedForClient(agentId, db)`. Reads `team_messages` with metadata, applies the redactor, returns the same `Anthropic.Messages.MessageParam[]` shape as the worker version. NEW function; doesn't replace `loadAgentRunHistory` (worker side keeps reading raw).
- `src/workers/processors/lib/__tests__/agent-run-history-for-client.test.ts` — integration test against an in-memory drizzle.
- `e2e/competitor-leak-smoke.spec.ts` — Playwright real-browser test simulating a paid competitor account that captures Network responses and asserts no banned strings appear.

**Modified files:**
- `src/app/api/team/conversations/[id]/messages/route.ts:283-294` — apply `redactMessageRowForClient` to the GET map.
- `src/app/api/team/events/route.ts:103-119, 139-140` — apply redactor to snapshot AND live forward in SSE.
- `src/app/api/team/activity/route.ts:102-114` — apply redactor to GET map.
- `src/app/api/team/agent/[agentId]/transcript/route.ts:85-90` — switch from `loadAgentRunHistory` to `loadAgentRunHistoryRedactedForClient`.
- `src/lib/team/dispatch-lead-message.ts:60-90` — accept optional `publicSummary?: string` arg; persist to `metadata.publicContent` when set.
- `src/lib/team-kickoff.ts:142-174` — pass `publicSummary` (`Setting up your week-1 plan and content for ${productRow.name}.`) when calling `dispatchLeadMessage`.
- `src/lib/xai-client.ts:170, 209, 281, 308, 355, 393, 486-489` — replace literal-query / literal-text logging with length-only or first-N-chars-only summaries.
- `src/app/(app)/team/_components/activity-log.tsx:484-521` — already reads `extractToolName(metadata)`; since server now sends labels, no change required, but verify `<code>{toolName}</code>` renders the label correctly (defense-in-depth check, not a code change).
- `src/app/(app)/team/_components/conversation-reducer.ts:344-372` — already reads `description` / `subagent_type` from `tool_input`; redactor preserves these two keys. Verify (no code change expected).

**Deleted files:**
- `public/ShipFlare Design System.zip`

---

## Architectural Conventions

These are the rules every task below must respect. Lock them in once; don't relitigate per task.

### Tool name taxonomy

```typescript
// 6 semantic buckets. Default fallback = 'tool'.
type PublicToolLabel =
  | 'searching'      // discovery, find_threads_*, query that hits external APIs
  | 'drafting'       // content generation
  | 'reviewing'      // validation, judging, audit
  | 'posting'        // platform writes (x_post, reddit_post)
  | 'planning'       // plan-item edits, strategic-path edits
  | 'reading-plan'   // query_plan_items, query_strategic_path
  | 'reading-context'// query_product_context, query_recent_milestones
  | 'reading-team'   // query_team_status
  | 'reading-metrics'// query_metrics, query_stalled_items
  | 'reading-history'// query_recent_x_posts
  | 'monitoring'     // x_get_mentions
  | 'verifying'      // reddit_verify
  | 'batching'       // process_*_batch
  | 'queueing'       // persist_queue_threads
  | 'delegating'     // Task
  | 'messaging'      // SendMessage
  | 'sleeping'       // Sleep
  | 'cancelling'     // TaskStop
  | 'skill'          // any skill_* prefix
  | 'tool';          // unknown / fallback (deny-by-default)
```

### Agent name display

```typescript
// Founder-facing labels. Default fallback = 'agent'.
const AGENT_DISPLAY_NAMES = {
  coordinator: 'Team Lead',
  'social-media-manager': 'Content Specialist',
};
// Future agents: add an entry. Don't expose internal type names.
```

### Metadata field rules

When a `team_messages` row crosses the API boundary into the browser:

| Field | Rule |
|-------|------|
| `id`, `runId`, `teamId`, `conversationId`, `fromMemberId`, `toMemberId`, `type`, `createdAt` | Pass through |
| `content` | If `metadata.publicContent` set, replace with that. Else pass through. |
| `contentBlocks` | If contains tool_use blocks, redact each block's `input` to `{}`. Pass through `tool_use_id`, `name` (mapped via `publicToolLabel`). |
| `metadata.tool_name` / `metadata.toolName` | Replace with `publicToolLabel(raw)`. |
| `metadata.tool_input` | Allowlist: keep ONLY `description` (stringified, ≤200 chars) and `subagent_type` (mapped via `publicAgentLabel`). Drop everything else, including raw `prompt`. |
| `metadata.tool_output` | Drop entirely. |
| `metadata.agent_name` | Replace with `publicAgentLabel(raw)`. |
| `metadata.parent_tool_use_id`, `tool_use_id`, `is_error`, `duration_ms` | Pass through (UI grouping needs these). |
| `metadata.publicContent` | Drop (already swapped into `content`). |
| Anything else in `metadata` | Drop (deny-by-default). |

### TDD discipline

Every task: write the failing test first, run it to confirm it fails for the *right reason*, then implement the minimum to make it pass. Commit after each green test. `pnpm tsc --noEmit` must pass before each commit.

---

## Task 1: Set up the redactor module skeleton

**Files:**
- Create: `src/lib/team/redact-for-client.ts`
- Test: `src/lib/team/__tests__/redact-for-client.test.ts`

- [ ] **Step 1: Write the failing test for module shape**

```typescript
// src/lib/team/__tests__/redact-for-client.test.ts
import { describe, expect, it } from 'vitest';
import {
  publicToolLabel,
  publicAgentLabel,
  publicSkillLabel,
  redactMetadataForClient,
  redactContentBlocksForClient,
  redactMessageRowForClient,
} from '../redact-for-client';

describe('redact-for-client module exports', () => {
  it('exports six functions', () => {
    expect(typeof publicToolLabel).toBe('function');
    expect(typeof publicAgentLabel).toBe('function');
    expect(typeof publicSkillLabel).toBe('function');
    expect(typeof redactMetadataForClient).toBe('function');
    expect(typeof redactContentBlocksForClient).toBe('function');
    expect(typeof redactMessageRowForClient).toBe('function');
  });
});
```

- [ ] **Step 2: Run test, confirm it fails because the module doesn't exist**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts`  
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Create the module skeleton**

```typescript
// src/lib/team/redact-for-client.ts

/**
 * Redaction helpers for the team_messages → client trust boundary.
 *
 * Why: team_messages rows persist raw tool_name / tool_input / tool_output
 * for worker correctness (nested Task() calls, history replay). Those fields
 * leak the multi-agent architecture, AI vendor choices, and proprietary
 * playbook prompts to any paid user who opens DevTools. This module strips
 * them at the API boundary while preserving the founder-facing UI signal
 * (semantic tool labels, friendly agent names, public summaries).
 *
 * All functions are pure: no DB, no I/O, no globals.
 */

export type PublicToolLabel = string;

export function publicToolLabel(rawName: string | null | undefined): PublicToolLabel {
  throw new Error('not implemented');
}

export function publicAgentLabel(rawType: string | null | undefined): string {
  throw new Error('not implemented');
}

export function publicSkillLabel(rawName: string | null | undefined): string {
  throw new Error('not implemented');
}

export function redactMetadataForClient(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  throw new Error('not implemented');
}

export function redactContentBlocksForClient(
  blocks: unknown,
): unknown {
  throw new Error('not implemented');
}

export interface MessageRowForClient {
  id: string;
  runId: string | null;
  teamId: string;
  conversationId?: string | null;
  fromMemberId?: string | null;
  toMemberId?: string | null;
  fromAgentId?: string | null;
  toAgentId?: string | null;
  type: string;
  messageType?: string;
  content: string | null;
  contentBlocks?: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
}

export function redactMessageRowForClient<T extends MessageRowForClient>(row: T): T {
  throw new Error('not implemented');
}
```

- [ ] **Step 4: Run test, confirm passes**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts`  
Expected: PASS.

- [ ] **Step 5: Run tsc to confirm types compile**

Run: `pnpm tsc --noEmit`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/team/redact-for-client.ts src/lib/team/__tests__/redact-for-client.test.ts
git commit -m "feat(security): scaffold team_messages client-redaction helper"
```

---

## Task 2: Implement `publicToolLabel` with the full label map

**Files:**
- Modify: `src/lib/team/redact-for-client.ts`
- Test: `src/lib/team/__tests__/redact-for-client.test.ts`

- [ ] **Step 1: Write the failing tests for every tool name**

Add to the test file:

```typescript
describe('publicToolLabel', () => {
  it.each([
    // Platform actions → 'posting' or specific label
    ['x_post', 'posting'],
    ['reddit_post', 'posting'],
    ['reddit_submit_post', 'posting'],
    ['reddit_verify', 'verifying'],
    ['reddit_search', 'searching'],
    ['x_get_mentions', 'monitoring'],
    ['x_get_tweet', 'reading-history'],

    // AI vendor binding → MUST hide xai
    ['xai_find_customers', 'searching'],
    ['find_threads_via_xai', 'searching'],
    ['find_threads', 'searching'],

    // Internal queries
    ['query_strategic_path', 'reading-plan'],
    ['query_plan_items', 'reading-plan'],
    ['query_product_context', 'reading-context'],
    ['query_recent_milestones', 'reading-context'],
    ['query_team_status', 'reading-team'],
    ['query_metrics', 'reading-metrics'],
    ['query_stalled_items', 'reading-metrics'],
    ['query_recent_x_posts', 'reading-history'],

    // Plan editing
    ['add_plan_item', 'planning'],
    ['update_plan_item', 'planning'],
    ['write_strategic_path', 'planning'],
    ['generate_strategic_path', 'planning'],

    // Content
    ['draft_post', 'drafting'],
    ['draft_reply', 'drafting'],
    ['validate_draft', 'reviewing'],

    // Pipeline
    ['process_posts_batch', 'batching'],
    ['process_replies_batch', 'batching'],
    ['persist_queue_threads', 'queueing'],

    // Memory
    ['read_memory', 'reading-context'],

    // Meta tools (Anthropic-standard naming, low IP value, but normalized)
    ['Task', 'delegating'],
    ['SendMessage', 'messaging'],
    ['Sleep', 'sleeping'],
    ['TaskStop', 'cancelling'],
    ['StructuredOutput', 'tool'],
    ['SyntheticOutput', 'tool'],

    // Skills
    ['skill', 'skill'],
    ['skill_drafting-post', 'skill'],
    ['skill_judging-thread-quality', 'skill'],
    ['skill_validating-draft', 'skill'],
    ['skill_generating-strategy', 'skill'],
  ])('maps %s -> %s', (raw, label) => {
    expect(publicToolLabel(raw)).toBe(label);
  });

  it('returns "tool" for unknown names (deny-by-default)', () => {
    expect(publicToolLabel('some_future_internal_tool')).toBe('tool');
  });

  it('returns "tool" for null/undefined', () => {
    expect(publicToolLabel(null)).toBe('tool');
    expect(publicToolLabel(undefined)).toBe('tool');
    expect(publicToolLabel('')).toBe('tool');
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts -t publicToolLabel`  
Expected: ALL FAIL with "not implemented" or assertion error.

- [ ] **Step 3: Implement `publicToolLabel`**

Replace the stub in `src/lib/team/redact-for-client.ts`:

```typescript
const TOOL_LABEL_MAP: Record<string, PublicToolLabel> = {
  // Platform actions
  x_post: 'posting',
  reddit_post: 'posting',
  reddit_submit_post: 'posting',
  reddit_verify: 'verifying',
  reddit_search: 'searching',
  x_get_mentions: 'monitoring',
  x_get_tweet: 'reading-history',

  // AI vendor binding — hide xai
  xai_find_customers: 'searching',
  find_threads_via_xai: 'searching',
  find_threads: 'searching',

  // Internal queries
  query_strategic_path: 'reading-plan',
  query_plan_items: 'reading-plan',
  query_product_context: 'reading-context',
  query_recent_milestones: 'reading-context',
  query_team_status: 'reading-team',
  query_metrics: 'reading-metrics',
  query_stalled_items: 'reading-metrics',
  query_recent_x_posts: 'reading-history',

  // Plan editing
  add_plan_item: 'planning',
  update_plan_item: 'planning',
  write_strategic_path: 'planning',
  generate_strategic_path: 'planning',

  // Content
  draft_post: 'drafting',
  draft_reply: 'drafting',
  validate_draft: 'reviewing',

  // Pipeline
  process_posts_batch: 'batching',
  process_replies_batch: 'batching',
  persist_queue_threads: 'queueing',

  // Memory
  read_memory: 'reading-context',

  // Meta tools (low IP, normalized)
  Task: 'delegating',
  SendMessage: 'messaging',
  Sleep: 'sleeping',
  TaskStop: 'cancelling',
  StructuredOutput: 'tool',
  SyntheticOutput: 'tool',
};

export function publicToolLabel(rawName: string | null | undefined): PublicToolLabel {
  if (!rawName) return 'tool';
  if (rawName === 'skill' || rawName.startsWith('skill_')) return 'skill';
  return TOOL_LABEL_MAP[rawName] ?? 'tool';
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts -t publicToolLabel`  
Expected: ALL PASS.

- [ ] **Step 5: Run tsc**

Run: `pnpm tsc --noEmit`  
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/team/redact-for-client.ts src/lib/team/__tests__/redact-for-client.test.ts
git commit -m "feat(security): map raw tool names to semantic labels for client"
```

---

## Task 3: Implement `publicAgentLabel` and `publicSkillLabel`

**Files:**
- Modify: `src/lib/team/redact-for-client.ts`
- Test: `src/lib/team/__tests__/redact-for-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to test file:

```typescript
describe('publicAgentLabel', () => {
  it.each([
    ['coordinator', 'Team Lead'],
    ['social-media-manager', 'Content Specialist'],
  ])('maps %s -> %s', (raw, label) => {
    expect(publicAgentLabel(raw)).toBe(label);
  });

  it('returns "agent" for unknown / null', () => {
    expect(publicAgentLabel(null)).toBe('agent');
    expect(publicAgentLabel(undefined)).toBe('agent');
    expect(publicAgentLabel('')).toBe('agent');
    expect(publicAgentLabel('some-future-internal-agent')).toBe('agent');
  });
});

describe('publicSkillLabel', () => {
  it('always returns "skill" — gerund names never leak', () => {
    expect(publicSkillLabel('drafting-post')).toBe('skill');
    expect(publicSkillLabel('judging-thread-quality')).toBe('skill');
    expect(publicSkillLabel('validating-draft')).toBe('skill');
    expect(publicSkillLabel(null)).toBe('skill');
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts -t "publicAgentLabel|publicSkillLabel"`  
Expected: FAIL with "not implemented".

- [ ] **Step 3: Implement both functions**

Replace stubs in `src/lib/team/redact-for-client.ts`:

```typescript
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  coordinator: 'Team Lead',
  'social-media-manager': 'Content Specialist',
};

export function publicAgentLabel(rawType: string | null | undefined): string {
  if (!rawType) return 'agent';
  return AGENT_DISPLAY_NAMES[rawType] ?? 'agent';
}

export function publicSkillLabel(_rawName: string | null | undefined): string {
  return 'skill';
}
```

- [ ] **Step 4: Run tests, confirm pass + tsc**

Run:
```bash
pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts
pnpm tsc --noEmit
```
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/redact-for-client.ts src/lib/team/__tests__/redact-for-client.test.ts
git commit -m "feat(security): map raw agent types to founder-facing labels"
```

---

## Task 4: Implement `redactMetadataForClient`

**Files:**
- Modify: `src/lib/team/redact-for-client.ts`
- Test: `src/lib/team/__tests__/redact-for-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to test file:

```typescript
describe('redactMetadataForClient', () => {
  it('returns null when input is null/undefined', () => {
    expect(redactMetadataForClient(null)).toBeNull();
    expect(redactMetadataForClient(undefined)).toBeNull();
  });

  it('redacts a tool_call metadata: maps tool_name, drops tool_input.prompt', () => {
    const input = {
      tool_use_id: 'tu_1',
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'social-media-manager',
        description: 'fill reply slot abc-123',
        prompt: 'Mode: discover-and-fill-slot\nplanItemId: abc-123\n...',
      },
      parent_tool_use_id: null,
      agent_name: 'coordinator',
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_1',
      tool_name: 'delegating',
      tool_input: {
        subagent_type: 'Content Specialist',
        description: 'fill reply slot abc-123',
      },
      parent_tool_use_id: null,
      agent_name: 'Team Lead',
    });
  });

  it('redacts xai-flavored tool name + drops raw prompt', () => {
    const input = {
      tool_use_id: 'tu_2',
      tool_name: 'find_threads_via_xai',
      tool_input: {
        query: 'startup founders complaining about cold outreach',
        from_date: '2026-01-01',
      },
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_2',
      tool_name: 'searching',
      tool_input: {}, // no description / subagent_type
    });

    // The raw query string MUST NOT appear anywhere in the output
    expect(JSON.stringify(out)).not.toContain('startup founders');
    expect(JSON.stringify(out)).not.toContain('xai');
  });

  it('redacts SkillTool metadata: strips skill name + args', () => {
    const input = {
      tool_use_id: 'tu_3',
      tool_name: 'skill',
      tool_input: {
        skill: 'judging-thread-quality',
        args: '{"thread": "...", "rubric": "..."}',
      },
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_3',
      tool_name: 'skill',
      tool_input: {},
    });
    expect(JSON.stringify(out)).not.toContain('judging-thread-quality');
    expect(JSON.stringify(out)).not.toContain('rubric');
  });

  it('redacts a tool_result metadata: drops tool_output, keeps duration + is_error', () => {
    const input = {
      tool_use_id: 'tu_1',
      tool_name: 'validate_draft',
      tool_output: 'REJECT: tone mismatch — cf rubric §3.2',
      is_error: false,
      duration_ms: 1200,
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_1',
      tool_name: 'reviewing',
      is_error: false,
      duration_ms: 1200,
    });
    expect(out).not.toHaveProperty('tool_output');
    expect(JSON.stringify(out)).not.toContain('rubric');
  });

  it('drops publicContent (already swapped into content by caller)', () => {
    const input = {
      tool_use_id: 'tu_x',
      tool_name: 'add_plan_item',
      publicContent: 'Setting up your week-1 plan',
    };
    const out = redactMetadataForClient(input);
    expect(out).not.toHaveProperty('publicContent');
  });

  it('drops unknown metadata keys (deny-by-default)', () => {
    const input = {
      tool_use_id: 'tu_x',
      tool_name: 'add_plan_item',
      future_field_with_secret: 'XAI_API_KEY=sk-...',
      another_internal_thing: { nested: 'leak' },
    };
    const out = redactMetadataForClient(input);
    expect(out).not.toHaveProperty('future_field_with_secret');
    expect(out).not.toHaveProperty('another_internal_thing');
    expect(JSON.stringify(out)).not.toContain('XAI_API_KEY');
    expect(JSON.stringify(out)).not.toContain('leak');
  });

  it('handles camelCase keys too (toolName, toolInput, parentToolUseId, agentName)', () => {
    const input = {
      toolUseId: 'tu_4',
      toolName: 'find_threads_via_xai',
      toolInput: { query: 'secret', description: 'searching for leads' },
      parentToolUseId: 'tu_3',
      agentName: 'social-media-manager',
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      toolUseId: 'tu_4',
      toolName: 'searching',
      toolInput: { description: 'searching for leads' },
      parentToolUseId: 'tu_3',
      agentName: 'Content Specialist',
    });
  });

  it('truncates description longer than 200 chars', () => {
    const longDesc = 'x'.repeat(500);
    const input = {
      tool_name: 'Task',
      tool_input: { description: longDesc, subagent_type: 'social-media-manager' },
    };
    const out = redactMetadataForClient(input);
    expect((out!.tool_input as { description: string }).description.length).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts -t redactMetadataForClient`  
Expected: FAIL.

- [ ] **Step 3: Implement `redactMetadataForClient`**

Replace stub in `src/lib/team/redact-for-client.ts`:

```typescript
const MAX_DESCRIPTION_LEN = 200;

interface NormalizedKeys {
  toolUseIdKey: 'tool_use_id' | 'toolUseId' | null;
  toolNameKey: 'tool_name' | 'toolName' | null;
  toolInputKey: 'tool_input' | 'toolInput' | null;
  parentKey: 'parent_tool_use_id' | 'parentToolUseId' | null;
  agentKey: 'agent_name' | 'agentName' | null;
}

function detectKeys(meta: Record<string, unknown>): NormalizedKeys {
  return {
    toolUseIdKey:
      'tool_use_id' in meta ? 'tool_use_id' : 'toolUseId' in meta ? 'toolUseId' : null,
    toolNameKey:
      'tool_name' in meta ? 'tool_name' : 'toolName' in meta ? 'toolName' : null,
    toolInputKey:
      'tool_input' in meta ? 'tool_input' : 'toolInput' in meta ? 'toolInput' : null,
    parentKey:
      'parent_tool_use_id' in meta
        ? 'parent_tool_use_id'
        : 'parentToolUseId' in meta
          ? 'parentToolUseId'
          : null,
    agentKey:
      'agent_name' in meta ? 'agent_name' : 'agentName' in meta ? 'agentName' : null,
  };
}

function redactToolInput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.description === 'string') {
    out.description = r.description.slice(0, MAX_DESCRIPTION_LEN);
  }
  if (typeof r.subagent_type === 'string') {
    out.subagent_type = publicAgentLabel(r.subagent_type);
  }
  return out;
}

export function redactMetadataForClient(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const keys = detectKeys(metadata);
  const out: Record<string, unknown> = {};

  if (keys.toolUseIdKey) out[keys.toolUseIdKey] = metadata[keys.toolUseIdKey];
  if (keys.toolNameKey) {
    out[keys.toolNameKey] = publicToolLabel(metadata[keys.toolNameKey] as string);
  }
  if (keys.toolInputKey) {
    out[keys.toolInputKey] = redactToolInput(metadata[keys.toolInputKey]);
  }
  if (keys.parentKey) out[keys.parentKey] = metadata[keys.parentKey];
  if (keys.agentKey) {
    out[keys.agentKey] = publicAgentLabel(metadata[keys.agentKey] as string);
  }

  // Pass-through scalars (no IP value).
  if ('is_error' in metadata) out.is_error = metadata.is_error;
  if ('duration_ms' in metadata) out.duration_ms = metadata.duration_ms;
  if ('trigger' in metadata) out.trigger = metadata.trigger;

  return out;
}
```

- [ ] **Step 4: Run tests, confirm pass + tsc**

Run:
```bash
pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts
pnpm tsc --noEmit
```
Expected: ALL PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/redact-for-client.ts src/lib/team/__tests__/redact-for-client.test.ts
git commit -m "feat(security): redact tool_input/tool_output/raw names from team_messages metadata"
```

---

## Task 5: Implement `redactContentBlocksForClient`

The `contentBlocks` column on assistant turns may contain Anthropic tool_use blocks like `{ type: 'tool_use', id, name, input: { prompt: '...' } }`. The transcript route serializes these via `JSON.stringify`, so they leak the same way.

**Files:**
- Modify: `src/lib/team/redact-for-client.ts`
- Test: `src/lib/team/__tests__/redact-for-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to test file:

```typescript
describe('redactContentBlocksForClient', () => {
  it('passes through plain text blocks', () => {
    const blocks = [{ type: 'text', text: 'Hello, founder!' }];
    expect(redactContentBlocksForClient(blocks)).toEqual(blocks);
  });

  it('redacts tool_use block input + maps name', () => {
    const blocks = [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'find_threads_via_xai',
        input: { query: 'secret query string', from_date: '2026-01-01' },
      },
    ];

    const out = redactContentBlocksForClient(blocks);

    expect(out).toEqual([
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'searching',
        input: {},
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('secret query');
    expect(JSON.stringify(out)).not.toContain('xai');
  });

  it('redacts Task tool_use: keeps description + maps subagent_type', () => {
    const blocks = [
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'Task',
        input: {
          subagent_type: 'social-media-manager',
          description: 'fill reply slot',
          prompt: 'Mode: discover-and-fill-slot\n...',
        },
      },
    ];

    const out = redactContentBlocksForClient(blocks);

    expect(out).toEqual([
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'delegating',
        input: { subagent_type: 'Content Specialist', description: 'fill reply slot' },
      },
    ]);
  });

  it('redacts tool_result blocks: keeps id + is_error, drops content', () => {
    const blocks = [
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: false,
        content: 'REJECT: tone mismatch — cf rubric §3.2',
      },
    ];

    const out = redactContentBlocksForClient(blocks);

    expect(out).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: false,
        content: '[redacted]',
      },
    ]);
  });

  it('returns input unchanged for non-array', () => {
    expect(redactContentBlocksForClient(null)).toBeNull();
    expect(redactContentBlocksForClient(undefined)).toBeUndefined();
    expect(redactContentBlocksForClient('plain string')).toBe('plain string');
  });

  it('mixed blocks: redacts only the dangerous ones', () => {
    const blocks = [
      { type: 'text', text: 'I am thinking...' },
      {
        type: 'tool_use',
        id: 'tu_3',
        name: 'judging-thread-quality',
        input: { thread_id: 't1' },
      },
      { type: 'text', text: 'Done.' },
    ];

    const out = redactContentBlocksForClient(blocks) as Array<Record<string, unknown>>;

    expect(out[0]).toEqual({ type: 'text', text: 'I am thinking...' });
    expect(out[1]).toEqual({
      type: 'tool_use',
      id: 'tu_3',
      name: 'tool', // judging-thread-quality is not a registered Anthropic tool name
      input: {},
    });
    expect(out[2]).toEqual({ type: 'text', text: 'Done.' });
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts -t redactContentBlocksForClient`  
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `src/lib/team/redact-for-client.ts`:

```typescript
interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

function redactBlock(block: AnthropicBlock): AnthropicBlock {
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: publicToolLabel(block.name as string),
      input: redactToolInput(block.input),
    };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      is_error: block.is_error ?? false,
      content: '[redacted]',
    };
  }
  // text, image, document, etc. — pass through
  return block;
}

export function redactContentBlocksForClient(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) =>
    typeof b === 'object' && b !== null ? redactBlock(b as AnthropicBlock) : b,
  );
}
```

- [ ] **Step 4: Run tests, confirm pass + tsc**

Run:
```bash
pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts
pnpm tsc --noEmit
```
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/redact-for-client.ts src/lib/team/__tests__/redact-for-client.test.ts
git commit -m "feat(security): redact tool_use/tool_result blocks in contentBlocks for client"
```

---

## Task 6: Implement `redactMessageRowForClient`

This is the public entrypoint each endpoint calls. It composes the helpers and handles the `metadata.publicContent` content swap.

**Files:**
- Modify: `src/lib/team/redact-for-client.ts`
- Test: `src/lib/team/__tests__/redact-for-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to test file:

```typescript
describe('redactMessageRowForClient', () => {
  const baseRow = {
    id: 'm1',
    runId: 'r1',
    teamId: 't1',
    type: 'tool_call',
    content: null,
    contentBlocks: null,
    metadata: null,
    createdAt: new Date('2026-05-04T00:00:00Z'),
  };

  it('redacts metadata + leaves identifiers intact', () => {
    const row = {
      ...baseRow,
      metadata: {
        tool_use_id: 'tu_1',
        tool_name: 'find_threads_via_xai',
        tool_input: { query: 'secret' },
      },
    };
    const out = redactMessageRowForClient(row);
    expect(out.id).toBe('m1');
    expect(out.runId).toBe('r1');
    expect(out.metadata).toEqual({
      tool_use_id: 'tu_1',
      tool_name: 'searching',
      tool_input: {},
    });
  });

  it('swaps content with metadata.publicContent if present', () => {
    const row = {
      ...baseRow,
      type: 'user_prompt',
      content:
        'First-visit kickoff for Acme. Strategic path pathId=... weekStart=... ' +
        'Follow your kickoff playbook end-to-end (plan → social-media-manager): ...',
      metadata: {
        trigger: 'kickoff',
        publicContent: 'Setting up your week-1 plan and content for Acme.',
      },
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Setting up your week-1 plan and content for Acme.');
    expect(out.metadata).toEqual({ trigger: 'kickoff' }); // publicContent dropped
    expect(out.content).not.toContain('social-media-manager');
    expect(out.content).not.toContain('playbook');
  });

  it('passes content through when publicContent absent', () => {
    const row = {
      ...baseRow,
      type: 'user_prompt',
      content: 'Hey team, what should I post today?',
      metadata: { trigger: 'conversation_message' },
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Hey team, what should I post today?');
  });

  it('redacts contentBlocks if present', () => {
    const row = {
      ...baseRow,
      type: 'assistant_text',
      contentBlocks: [
        { type: 'text', text: 'Thinking...' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'find_threads_via_xai',
          input: { query: 'secret' },
        },
      ],
    };
    const out = redactMessageRowForClient(row);
    expect(out.contentBlocks).toEqual([
      { type: 'text', text: 'Thinking...' },
      { type: 'tool_use', id: 'tu_1', name: 'searching', input: {} },
    ]);
  });
});
```

- [ ] **Step 2: Run tests, confirm fail**

Run: `pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts -t redactMessageRowForClient`  
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the stub:

```typescript
export function redactMessageRowForClient<T extends MessageRowForClient>(row: T): T {
  const meta = row.metadata ?? null;
  const publicContent =
    meta && typeof meta === 'object' && typeof meta.publicContent === 'string'
      ? meta.publicContent
      : null;

  return {
    ...row,
    content: publicContent ?? row.content,
    contentBlocks: row.contentBlocks
      ? redactContentBlocksForClient(row.contentBlocks)
      : row.contentBlocks,
    metadata: redactMetadataForClient(meta),
  };
}
```

- [ ] **Step 4: Run all redactor tests + tsc**

Run:
```bash
pnpm vitest run src/lib/team/__tests__/redact-for-client.test.ts
pnpm tsc --noEmit
```
Expected: ALL PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/redact-for-client.ts src/lib/team/__tests__/redact-for-client.test.ts
git commit -m "feat(security): public redactMessageRowForClient composes content+metadata redaction"
```

---

## Task 7: Wire redactor into `/api/team/conversations/[id]/messages` GET

**Files:**
- Modify: `src/app/api/team/conversations/[id]/messages/route.ts`
- Test: `src/app/api/team/conversations/[id]/__tests__/messages.test.ts` (create if absent)

- [ ] **Step 1: Write the failing integration test**

Find or create `src/app/api/team/conversations/[id]/__tests__/messages.test.ts`. The test fixture inserts a `team_messages` row with raw `tool_input.prompt = 'Mode: discover-and-fill-slot'` then asserts the GET response does not contain that string.

```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '../messages/route';
// import test DB setup helpers from your existing test fixtures
// (e.g. createTestDb, seedUser, seedTeam, seedConversation, signInAs)

describe('GET /api/team/conversations/[id]/messages — redaction', () => {
  it('returns redacted metadata.tool_name and strips raw tool_input.prompt', async () => {
    // ARRANGE: seed a conversation with a tool_call row carrying a Task prompt
    const { userId, teamId, conversationId, db } = await seedTestEnv();
    await db.insert(teamMessages).values({
      teamId,
      conversationId,
      type: 'tool_call',
      messageType: 'message',
      content: null,
      metadata: {
        tool_use_id: 'tu_secret',
        tool_name: 'find_threads_via_xai',
        tool_input: {
          query: 'startup founders complaining about cold outreach',
        },
      },
      createdAt: new Date(),
    });

    // ACT
    const req = new NextRequest(
      `http://localhost/api/team/conversations/${conversationId}/messages`,
    );
    mockSession(userId);
    const res = await GET(req, { params: Promise.resolve({ id: conversationId }) });
    const body = await res.json();

    // ASSERT
    const msg = body.messages.find((m: { id: string }) => m.id);
    expect(msg.metadata.tool_name).toBe('searching');
    expect(JSON.stringify(body)).not.toContain('xai');
    expect(JSON.stringify(body)).not.toContain('startup founders');
    expect(JSON.stringify(body)).not.toContain('find_threads_via_xai');
  });
});
```

(If the codebase already has a setup helper, follow its pattern; do not invent a new test fixture from scratch.)

- [ ] **Step 2: Run test, confirm fail**

Run: `pnpm vitest run src/app/api/team/conversations/[id]/__tests__/messages.test.ts`  
Expected: FAIL — current code passes raw `tool_name` and `tool_input.query` straight through.

- [ ] **Step 3: Apply the redactor**

In `src/app/api/team/conversations/[id]/messages/route.ts`, modify the GET response (around line 283):

```typescript
import { redactMessageRowForClient } from '@/lib/team/redact-for-client';

// ... in GET, replace the .map():
return NextResponse.json(
  {
    conversationId,
    title: conv.title,
    updatedAt: conv.updatedAt.toISOString(),
    messages: messages.map((m) => {
      const redacted = redactMessageRowForClient({
        ...m,
        teamId: conv.teamId,
      });
      return {
        ...redacted,
        createdAt:
          redacted.createdAt instanceof Date
            ? redacted.createdAt.toISOString()
            : String(redacted.createdAt),
      };
    }),
  },
  { status: 200 },
);
```

- [ ] **Step 4: Run test, confirm pass + tsc**

Run:
```bash
pnpm vitest run src/app/api/team/conversations/[id]/__tests__/messages.test.ts
pnpm tsc --noEmit
```
Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/team/conversations/[id]/messages/route.ts src/app/api/team/conversations/[id]/__tests__/messages.test.ts
git commit -m "fix(security): redact internal metadata in GET conversations/[id]/messages"
```

---

## Task 8: Wire redactor into `/api/team/activity` GET

**Files:**
- Modify: `src/app/api/team/activity/route.ts`
- Test: `src/app/api/team/__tests__/activity.test.ts` (create if absent; match Task 7 pattern)

- [ ] **Step 1: Write integration test (mirror Task 7 shape)**

```typescript
describe('GET /api/team/activity — redaction', () => {
  it('strips tool_input.prompt + maps tool_name', async () => {
    const { userId, teamId, memberId, db } = await seedTestEnv();
    await db.insert(teamMessages).values({
      teamId,
      fromMemberId: memberId,
      type: 'tool_call',
      messageType: 'message',
      metadata: {
        tool_use_id: 'tu_x',
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'social-media-manager',
          description: 'fill reply slot',
          prompt: 'Mode: discover-and-fill-slot\nplanItemId: ...',
        },
      },
      createdAt: new Date(),
    });

    mockSession(userId);
    const req = new NextRequest(`http://localhost/api/team/activity?memberId=${memberId}`);
    const res = await GET(req);
    const body = await res.json();

    const msg = body.messages[0];
    expect(msg.metadata.tool_name).toBe('delegating');
    expect(msg.metadata.tool_input).toEqual({
      subagent_type: 'Content Specialist',
      description: 'fill reply slot',
    });
    expect(JSON.stringify(body)).not.toContain('discover-and-fill-slot');
    expect(JSON.stringify(body)).not.toContain('social-media-manager');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

- [ ] **Step 3: Apply redactor in `src/app/api/team/activity/route.ts`**

Replace the response `.map()` (lines 102-114):

```typescript
import { redactMessageRowForClient } from '@/lib/team/redact-for-client';

// ... in GET:
return NextResponse.json({
  member: {
    id: member.id,
    teamId: member.teamId,
    agentType: member.agentType,
    displayName: member.displayName,
    status: member.status,
    lastActiveAt: member.lastActiveAt,
  },
  messages: rows.map((m) => {
    const redacted = redactMessageRowForClient({
      id: m.id,
      runId: m.runId,
      teamId: m.teamId,
      fromMemberId: m.fromMemberId,
      toMemberId: m.toMemberId,
      type: m.type,
      content: m.content,
      metadata: m.metadata as Record<string, unknown> | null,
      createdAt: m.createdAt,
    });
    return {
      ...redacted,
      from: redacted.fromMemberId,
      to: redacted.toMemberId,
      createdAt:
        redacted.createdAt instanceof Date
          ? redacted.createdAt.toISOString()
          : String(redacted.createdAt),
    };
  }),
});
```

- [ ] **Step 4: Run test + tsc**

Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/team/activity/route.ts src/app/api/team/__tests__/activity.test.ts
git commit -m "fix(security): redact internal metadata in GET team/activity"
```

---

## Task 9: Wire redactor into `/api/team/events` SSE (snapshot AND live forward)

The SSE endpoint has TWO leakage points: the snapshot loop (lines 103-119) and the Redis-pubsub live forwarder (lines 126-144). Both must be redacted.

**Files:**
- Modify: `src/app/api/team/events/route.ts`
- Test: `src/app/api/team/__tests__/events.test.ts` (snapshot only; live forward is harder to test in-process)

- [ ] **Step 1: Write the failing snapshot test**

```typescript
describe('GET /api/team/events SSE — snapshot redaction', () => {
  it('snapshot frames do not contain raw tool names or inputs', async () => {
    const { userId, teamId, db } = await seedTestEnv();
    await db.insert(teamMessages).values({
      teamId,
      type: 'tool_call',
      messageType: 'message',
      metadata: {
        tool_name: 'xai_find_customers',
        tool_input: { query: 'leak this' },
      },
      createdAt: new Date(),
    });

    mockSession(userId);
    const req = new NextRequest(`http://localhost/api/team/events?teamId=${teamId}`);
    const res = await GET(req);

    // Read the SSE stream until snapshot_end. Concatenate the chunks.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes('"snapshot_end"')) break;
    }
    await reader.cancel(); // close the SSE so the test exits

    expect(buf).not.toContain('xai');
    expect(buf).not.toContain('leak this');
    expect(buf).toContain('"messageType":"snapshot"'); // sanity
    expect(buf).toContain('"tool_name":"searching"');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

- [ ] **Step 3: Patch SSE route**

In `src/app/api/team/events/route.ts`:

```typescript
import { redactMessageRowForClient } from '@/lib/team/redact-for-client';

// ... in the snapshot loop (around line 103):
for (const msg of snapshot) {
  const redacted = redactMessageRowForClient({
    id: msg.id,
    runId: msg.runId,
    teamId: msg.teamId,
    conversationId: msg.conversationId,
    fromMemberId: msg.fromMemberId,
    toMemberId: msg.toMemberId,
    type: msg.type,
    content: msg.content,
    contentBlocks: msg.contentBlocks,
    metadata: msg.metadata as Record<string, unknown> | null,
    createdAt: msg.createdAt,
  });
  send({
    type: 'snapshot',
    messageId: redacted.id,
    runId: redacted.runId,
    conversationId: redacted.conversationId,
    teamId: redacted.teamId,
    from: redacted.fromMemberId,
    to: redacted.toMemberId,
    messageType: redacted.type,
    content: redacted.content,
    metadata: redacted.metadata,
    createdAt:
      redacted.createdAt instanceof Date
        ? redacted.createdAt.toISOString()
        : String(redacted.createdAt),
  });
}

// ... in the live-forward subscriber (around line 126):
subscriber.on('message', (_ch: string, message: string) => {
  if (closed) return;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (runId && parsed.runId && parsed.runId !== runId) return;
    const { type: messageType, ...rest } = parsed;

    // Apply redactor. The pubsub payload uses the same field names as
    // team_messages rows; route through redactMessageRowForClient.
    const redacted = redactMessageRowForClient({
      id: (rest.messageId as string) ?? '',
      runId: (rest.runId as string) ?? null,
      teamId: (rest.teamId as string) ?? '',
      conversationId: (rest.conversationId as string | null) ?? null,
      fromMemberId: (rest.from as string | null) ?? null,
      toMemberId: (rest.to as string | null) ?? null,
      type: String(messageType ?? 'unknown'),
      content: (rest.content as string | null) ?? null,
      contentBlocks: rest.contentBlocks ?? null,
      metadata: (rest.metadata as Record<string, unknown> | null) ?? null,
      createdAt: (rest.createdAt as string) ?? new Date().toISOString(),
    });

    send({
      ...rest,
      content: redacted.content,
      metadata: redacted.metadata,
      contentBlocks: redacted.contentBlocks,
      type: 'event',
      messageType,
    });
  } catch {
    // ignore malformed
  }
});
```

- [ ] **Step 4: Run test + tsc**

Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/team/events/route.ts src/app/api/team/__tests__/events.test.ts
git commit -m "fix(security): redact metadata in SSE snapshot and live-forward"
```

---

## Task 10: Forked transcript history loader for client + wire into `/transcript`

**Files:**
- Create: `src/workers/processors/lib/agent-run-history-for-client.ts`
- Create: `src/workers/processors/lib/__tests__/agent-run-history-for-client.test.ts`
- Modify: `src/app/api/team/agent/[agentId]/transcript/route.ts:85-90`

- [ ] **Step 1: Write the failing test for the new loader**

```typescript
// src/workers/processors/lib/__tests__/agent-run-history-for-client.test.ts
describe('loadAgentRunHistoryRedactedForClient', () => {
  it('redacts tool_use blocks inside assistant content arrays', async () => {
    const { db, agentId } = await seedAgentRunWithToolCall({
      toolName: 'find_threads_via_xai',
      toolInput: { query: 'leak me' },
    });

    const messages = await loadAgentRunHistoryRedactedForClient(agentId, db);

    const json = JSON.stringify(messages);
    expect(json).not.toContain('xai');
    expect(json).not.toContain('leak me');
    expect(json).toContain('"name":"searching"');
  });

  it('swaps content with metadata.publicContent for kickoff user_prompt', async () => {
    const { db, agentId } = await seedAgentRunWithKickoff({
      content: 'First-visit kickoff for Acme. Strategic path... Follow your kickoff playbook end-to-end (plan → social-media-manager): ...',
      publicContent: 'Setting up your week-1 plan and content for Acme.',
    });

    const messages = await loadAgentRunHistoryRedactedForClient(agentId, db);

    const json = JSON.stringify(messages);
    expect(json).not.toContain('social-media-manager');
    expect(json).not.toContain('playbook');
    expect(json).toContain('Setting up your week-1 plan');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

- [ ] **Step 3: Implement**

```typescript
// src/workers/processors/lib/agent-run-history-for-client.ts
import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { teamMessages } from '@/lib/db/schema';
import { redactContentBlocksForClient } from '@/lib/team/redact-for-client';

/**
 * Like `loadAgentRunHistory`, but with internal-IP redaction applied.
 * Use this from any route that returns history to the browser. The
 * worker still uses the un-redacted `loadAgentRunHistory` for resume.
 */
export async function loadAgentRunHistoryRedactedForClient(
  agentId: string,
  db: Database,
): Promise<Anthropic.Messages.MessageParam[]> {
  const rows = await db
    .select({
      fromAgentId: teamMessages.fromAgentId,
      toAgentId: teamMessages.toAgentId,
      content: teamMessages.content,
      contentBlocks: teamMessages.contentBlocks,
      metadata: teamMessages.metadata,
    })
    .from(teamMessages)
    .where(
      and(
        or(
          eq(teamMessages.fromAgentId, agentId),
          eq(teamMessages.toAgentId, agentId),
        ),
        isNotNull(teamMessages.deliveredAt),
      ),
    )
    .orderBy(asc(teamMessages.createdAt));

  const out: Anthropic.Messages.MessageParam[] = [];
  for (const row of rows) {
    const role: 'assistant' | 'user' =
      row.fromAgentId === agentId ? 'assistant' : 'user';

    const meta = (row.metadata as Record<string, unknown> | null) ?? null;
    const publicContent =
      meta && typeof meta.publicContent === 'string' ? meta.publicContent : null;

    let content: Anthropic.Messages.MessageParam['content'];
    if (Array.isArray(row.contentBlocks)) {
      content = redactContentBlocksForClient(
        row.contentBlocks,
      ) as Anthropic.Messages.ContentBlockParam[];
    } else if (publicContent) {
      content = publicContent;
    } else if (typeof row.content === 'string') {
      content = row.content;
    } else {
      continue; // null content, no replay value
    }

    out.push({ role, content });
  }
  return out;
}
```

- [ ] **Step 4: Wire into `/transcript`**

In `src/app/api/team/agent/[agentId]/transcript/route.ts`:

```typescript
// REPLACE the import:
import { loadAgentRunHistoryRedactedForClient } from '@/workers/processors/lib/agent-run-history-for-client';

// REPLACE line 85:
const raw = await loadAgentRunHistoryRedactedForClient(agentId, db);
```

- [ ] **Step 5: Run tests + tsc**

Run:
```bash
pnpm vitest run src/workers/processors/lib/__tests__/agent-run-history-for-client.test.ts
pnpm tsc --noEmit
```
Expected: PASS / exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/lib/agent-run-history-for-client.ts \
        src/workers/processors/lib/__tests__/agent-run-history-for-client.test.ts \
        src/app/api/team/agent/[agentId]/transcript/route.ts
git commit -m "fix(security): redact agent transcript history before serving to client"
```

---

## Task 11: Add `publicSummary` support to `dispatchLeadMessage`

**Files:**
- Modify: `src/lib/team/dispatch-lead-message.ts`
- Test: `src/lib/team/__tests__/dispatch-lead-message.test.ts` (create if absent; verify metadata.publicContent is persisted)

- [ ] **Step 1: Write the failing test**

```typescript
describe('dispatchLeadMessage publicSummary', () => {
  it('persists publicSummary into metadata.publicContent', async () => {
    const { db, teamId, conversationId } = await seedTestEnv();
    await dispatchLeadMessage(
      {
        teamId,
        conversationId,
        goal: 'Internal raw goal with playbook details: ...',
        publicSummary: 'Setting up your week-1 plan',
        trigger: 'kickoff',
      },
      db,
    );
    const [row] = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.teamId, teamId))
      .orderBy(desc(teamMessages.createdAt))
      .limit(1);

    expect(row.content).toBe('Internal raw goal with playbook details: ...');
    expect(row.metadata).toMatchObject({
      trigger: 'kickoff',
      publicContent: 'Setting up your week-1 plan',
    });
  });

  it('omits publicContent when publicSummary not passed (back-compat)', async () => {
    const { db, teamId, conversationId } = await seedTestEnv();
    await dispatchLeadMessage(
      { teamId, conversationId, goal: 'plain goal', trigger: 'manual' },
      db,
    );
    const [row] = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.teamId, teamId))
      .orderBy(desc(teamMessages.createdAt))
      .limit(1);
    expect(row.metadata).not.toHaveProperty('publicContent');
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

- [ ] **Step 3: Add the field to `dispatchLeadMessage`**

In `src/lib/team/dispatch-lead-message.ts`, locate the input type and the insert call:

```typescript
// Add to the input interface:
export interface DispatchLeadInput {
  teamId: string;
  conversationId?: string;
  goal: string;
  trigger: string;
  publicSummary?: string;     // NEW
}

// In the function body, around the metadata construction:
const metadata: Record<string, unknown> = { trigger: input.trigger };
if (input.publicSummary) {
  metadata.publicContent = input.publicSummary;
}

// Use that `metadata` object in the insert.
```

(Adapt to actual existing structure — don't rewrite the file's overall flow; only add the field and the conditional metadata key.)

- [ ] **Step 4: Run test + tsc**

Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team/dispatch-lead-message.ts src/lib/team/__tests__/dispatch-lead-message.test.ts
git commit -m "feat(security): dispatchLeadMessage supports optional publicSummary for client redaction"
```

---

## Task 12: Wire `publicSummary` through `team-kickoff`

**Files:**
- Modify: `src/lib/team-kickoff.ts:142-174`
- Test: `src/lib/__tests__/team-kickoff.test.ts` (existing — extend it)

- [ ] **Step 1: Extend the existing kickoff test**

```typescript
it('kickoff dispatches with a publicSummary that excludes architecture details', async () => {
  // Run kickoff via ensureKickoffEnqueued
  const result = await ensureKickoffEnqueued({ userId, productId, teamId });
  expect(result.fired).toBe(true);

  const [row] = await db
    .select()
    .from(teamMessages)
    .where(eq(teamMessages.teamId, teamId))
    .orderBy(desc(teamMessages.createdAt))
    .limit(1);

  // raw content keeps the full goal (lead needs it)
  expect(row.content).toContain('social-media-manager');
  expect(row.content).toContain('playbook');

  // metadata carries a clean public summary
  const meta = row.metadata as Record<string, unknown>;
  expect(typeof meta.publicContent).toBe('string');
  expect(meta.publicContent).not.toContain('social-media-manager');
  expect(meta.publicContent).not.toContain('playbook');
  expect(meta.publicContent).not.toContain('Task(');
});
```

- [ ] **Step 2: Run test, confirm fail**

- [ ] **Step 3: Patch team-kickoff.ts**

Locate the `dispatchLeadMessage` call (line 166) and the `goal` string (line 142). Add a public summary above the call:

```typescript
const publicSummary =
  `Setting up your week-1 plan${pathId ? ' and content drafts' : ''} for ${productRow.name}.`;

const { runId } = await dispatchLeadMessage(
  {
    teamId,
    conversationId,
    goal,
    publicSummary,
    trigger: 'kickoff',
  },
  db,
);
```

- [ ] **Step 4: Run test + tsc**

Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/team-kickoff.ts src/lib/__tests__/team-kickoff.test.ts
git commit -m "fix(security): kickoff goal carries publicSummary; raw playbook stays server-side"
```

---

## Task 13: Redact xai-client logs

**Files:**
- Modify: `src/lib/xai-client.ts`
- Test: `src/lib/__tests__/xai-client.test.ts` (existing — extend it; mock the logger)

- [ ] **Step 1: Write the failing test**

```typescript
describe('xai-client logging redaction', () => {
  it('does not log raw query strings', async () => {
    const calls: string[] = [];
    const fakeLogger = { info: (s: string) => calls.push(s), warn: (s: string) => calls.push(s), debug: (s: string) => calls.push(s), error: (s: string) => calls.push(s) };
    vi.spyOn(loggerModule, 'createLogger').mockReturnValue(fakeLogger);

    const client = new XAIClient('test-key');
    // Mock fetch to return an empty xAI response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: [], citations: [] })));

    await client.searchTweets('startup founders complaining about cold outreach');

    const allLogs = calls.join('\n');
    expect(allLogs).not.toContain('startup founders');
    expect(allLogs).not.toContain('cold outreach');
  });

  it('does not log raw model output text', async () => {
    // ... similar setup, but assert that text.slice(0, 200) is replaced with a length summary
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

- [ ] **Step 3: Patch xai-client.ts**

Replace logging lines:

```typescript
// Line 170: BEFORE
log.debug(`Searching X via xAI: "${query}"`);
// AFTER
log.debug(`xAI search request: query length=${query.length}`);

// Line 209: BEFORE
log.info(
  `xAI search returned ${tweets.length} tweets, ${data.server_side_tool_usage?.x_search_calls ?? 0} search calls`,
);
// AFTER
log.info(
  `xAI search: tweets=${tweets.length} calls=${data.server_side_tool_usage?.x_search_calls ?? 0}`,
);

// Line 281: BEFORE
log.debug(`Batch searching X via xAI: ${queries.length} queries`);
// AFTER (already safe — count only — keep)

// Line 486-489: BEFORE
log.warn(
  `respondConversational: xAI returned non-JSON despite ` +
    `response_format=json_schema. parseError=${parseError} ` +
    `text="${text.slice(0, 200)}..."`,
);
// AFTER
log.warn(
  `respondConversational: xAI returned non-JSON despite response_format=json_schema. ` +
    `parseError=${parseError} text_length=${text.length}`,
);
```

- [ ] **Step 4: Run tests + tsc**

Expected: PASS / exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/xai-client.ts src/lib/__tests__/xai-client.test.ts
git commit -m "fix(security): redact query strings and model output from xai-client logs"
```

---

## Task 14: Delete `public/ShipFlare Design System.zip`

**Files:**
- Delete: `public/ShipFlare Design System.zip`

- [ ] **Step 1: Confirm nothing references it**

Run:
```bash
grep -rn "ShipFlare Design System" src docs --include="*.ts" --include="*.tsx" --include="*.md" 2>/dev/null
```
Expected: zero or only docs-only references.

- [ ] **Step 2: Delete the file**

```bash
git rm "public/ShipFlare Design System.zip"
```

- [ ] **Step 3: Add to .gitignore guard for future**

In `.gitignore`, add (if not present):
```
# Internal design assets must never live in /public
/public/*Design System*
/public/*design-system*
```

- [ ] **Step 4: Verify no broken refs + tsc + build**

Run:
```bash
grep -rn "Design System.zip" . --include="*.ts" --include="*.tsx" --include="*.md" 2>/dev/null
pnpm tsc --noEmit
pnpm build
```
Expected: zero hits / clean build.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "fix(security): remove internal design system zip from /public"
```

---

## Task 15: Real-browser Playwright smoke — competitor leak verification

**Files:**
- Create: `e2e/competitor-leak-smoke.spec.ts`

This uses Playwright's existing connection to your locally-authenticated GitHub session (per the user's standing preference). It signs in as a normal account, triggers a kickoff, captures every Network response on the team page, and asserts no banned strings appear.

- [ ] **Step 1: Identify the existing Playwright config & a known fixture user**

```bash
ls e2e/ playwright.config.* 2>/dev/null
```

Confirm the project has Playwright configured. If not, this task is BLOCKED and the user must set it up first.

- [ ] **Step 2: Write the spec**

```typescript
// e2e/competitor-leak-smoke.spec.ts
import { test, expect } from '@playwright/test';

const BANNED_STRINGS = [
  // AI vendor binding
  'xai_find_customers',
  'find_threads_via_xai',
  'XAI_API_KEY',
  // Internal agent + skill names
  'social-media-manager',
  'coordinator',
  'judging-thread-quality',
  'drafting-post',
  'drafting-reply',
  'validating-draft',
  'allocating-plan-items',
  'generating-strategy',
  'posting-to-platform',
  // Pipeline tools
  'process_posts_batch',
  'process_replies_batch',
  'persist_queue_threads',
  'find_threads',
  'add_plan_item',
  'update_plan_item',
  'query_plan_items',
  'query_strategic_path',
  'query_product_context',
  // Kickoff playbook
  'discover-and-fill-slot',
  'kickoff playbook',
  'subagent_type',
];

test.describe('Competitor leakage smoke', () => {
  test('team page network responses contain no internal architecture strings', async ({
    page,
  }) => {
    const networkBodies: string[] = [];
    page.on('response', async (res) => {
      const url = res.url();
      // Only inspect our own API surface
      if (!url.includes('/api/team/')) return;
      try {
        const body = await res.text();
        networkBodies.push(`${url}\n${body}`);
      } catch {
        // ignore non-text responses
      }
    });

    // Sign in. Adapt to existing auth fixture — this assumes a /signin
    // dev shortcut or pre-authed cookies via storageState.
    await page.goto('/team');

    // Wait for the kickoff dispatch + first SSE frames.
    await page.waitForResponse((r) => r.url().includes('/api/team/events'), {
      timeout: 30_000,
    });
    await page.waitForTimeout(5_000); // let some SSE frames flow

    const dump = networkBodies.join('\n---\n');
    for (const banned of BANNED_STRINGS) {
      expect(dump, `banned string "${banned}" appeared in /api/team/* response`).not.toContain(
        banned,
      );
    }
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm playwright test e2e/competitor-leak-smoke.spec.ts --headed
```

Expected: PASS. If FAIL, the failing assertion names the leaked string — go fix the corresponding endpoint.

- [ ] **Step 4: Commit**

```bash
git add e2e/competitor-leak-smoke.spec.ts
git commit -m "test(security): real-browser smoke asserting no internal architecture leaks"
```

---

## Task 16: Final manual verification + grep gate

**Files:**
- (verification only, no code changes)

- [ ] **Step 1: Run full unit test suite**

Run: `pnpm vitest run`  
Expected: ALL PASS.

- [ ] **Step 2: Run tsc**

Run: `pnpm tsc --noEmit`  
Expected: exit 0.

- [ ] **Step 3: Run production build**

Run: `pnpm build`  
Expected: build succeeds.

- [ ] **Step 4: Spot-check one live endpoint manually**

Start the dev server, sign in, hit:
```bash
curl -s -H "Cookie: <auth-cookie>" \
  "http://localhost:3000/api/team/conversations/<conv-id>/messages" \
  | jq '.messages[].metadata' | grep -iE "xai|social-media-manager|playbook|prompt"
```
Expected: no matches.

- [ ] **Step 5: Re-run the original /cso scan to confirm findings 1, 2, 3, 4, 5, 6 closed**

- [ ] **Step 6: Final commit if any leftover fixes were needed**

---

## Self-Review

I went back through the spec with fresh eyes. Items I want to flag:

**1. Spec coverage check.** All six findings from the audit map to tasks:
- Finding 1 (`tool_input` / `tool_output` leak) → Tasks 4, 7, 8, 9, 10
- Finding 2 (kickoff goal in `content`) → Tasks 6, 11, 12
- Finding 3 (`tool_name` raw + skill gerunds) → Tasks 2, 3 + applied via 4, 7, 8, 9, 10
- Finding 4 (public design zip) → Task 14
- Finding 5 (xai-client logs) → Task 13
- Finding 6 (`/transcript` JSON.stringify) → Task 10

**2. Placeholder scan.** I found and avoided:
- "appropriate error handling" — not used
- "TBD" — not used
- "similar to Task N" — Tasks 7-9 deliberately repeat the redactor wiring rather than ref-link, because each endpoint shape differs slightly

**3. Type consistency.** `redactMessageRowForClient` returns `T extends MessageRowForClient`, called from 4 places with slightly different row shapes. The generic param keeps narrower input types intact. `MessageRowForClient` interface lists every field any caller passes; if a future caller has more fields, TypeScript will forgive them under structural typing.

**4. Open question for the implementer.** Task 7's test fixture references `seedTestEnv()`, `mockSession()`. These need to either already exist in the repo or be created in Task 7's first step. Quick `grep -rn "seedTestEnv\|mockSession" src/__tests__ src/**/__tests__` before starting Task 7 — if absent, add a tiny helper file rather than inlining setup in every test.

**5. Risk.** The SSE live-forward redaction in Task 9 transforms the publish payload shape. If any other consumer subscribes to the same `team:${teamId}:messages` channel and depends on raw `metadata`, it'll break. As of 2026-05-04 I see only the SSE endpoint consuming this channel, but a `grep -rn "team:.*messages" src` should be done before merging to confirm.

**6. Skill-list completeness.** Task 2's `TOOL_LABEL_MAP` covers every tool name in the registry today. If a new tool ships before this PR lands, it falls through to `'tool'` (deny-by-default) — safe default. Add to map in a follow-up.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-redact-internal-metadata-from-client.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
