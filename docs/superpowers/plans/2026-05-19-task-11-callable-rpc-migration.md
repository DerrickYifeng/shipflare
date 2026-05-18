# Task #11 — Callable RPC Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the retired `/agents/cmo/<userId>/mcp` browser path with `@callable` methods on CMO over the existing chat WebSocket. Restore the `/team` + `/briefing` + `/growth/reddit-channels` right-panel data and delete the dead StreamableHTTP client.

**Architecture:** `useAgent` already opens a JWT-authed WebSocket to CMO for chat. Piggyback queries on the same connection via `agent.call(method, args)`. CMO exposes 13 `@callable` methods: 10 wrap existing AI-SDK tool implementations (shared via extracted `_impl` methods), 1 derives a static roster from `EMPLOYEE_REGISTRY`, 2 manage a new `conversations` table.

**Tech Stack:** TypeScript, Cloudflare Workers, agents@0.12.4 (`@callable` + `useAgent`), `@cloudflare/ai-chat@0.7.0` (`AIChatAgent` + `useAgentChat`), Next.js 15 / React 19, vitest-pool-workers, Playwright (manual real-browser smoke on staging).

**Spec:** `docs/superpowers/specs/2026-05-19-task-11-callable-rpc-migration-design.md`

**Branch:** dev (clean at `7b6d1520` after design commits). All commits land on dev — this folds into the open `feat/cf-native-chat-migration` PR before that merges to main.

**Subagent model for dispatchers:** every subagent in this plan runs with `model: 'opus'`. Per-task spec + code review is mandatory (don't skip — established pattern from the cf-native-chat migration). Use `isolation: "worktree"` for any parallel dispatch.

**Build gate:** `pnpm tsc --noEmit` (NOT vitest — vitest-pool-workers uses isolatedModules so type-correctness must be checked separately). Per-package via `pnpm --filter <pkg-name> exec tsc --noEmit`.

---

## File map

**Modify**
- `apps/core/src/agents/cmo/CMO.ts` — extract 10 `_impl` methods; add 13 `@callable` methods; rewrite `getTools()` to delegate to `_impl`s; add `queryRoster` registry derivation; add `startNewConversation` + `listConversations`
- `apps/core/src/agents/cmo/schema.ts` — append `conversations` table CREATE; rewrite header comment to clarify `conversations` came back
- `apps/core/src/index.ts` — delete `handleMcpRequest` (lines 721-764); delete `MCP_ROUTE` regex (line 187) + its match block (lines 515-519); keep CMO_WS_ROUTE + CMO_HTTP_ROUTE
- `apps/core/test/agents/cmo.test.ts` — update tool-count assertion (still 15 tools, but add coverage for callable presence)
- `apps/core/test/cmo-routing.test.ts` — drop the 401/403 assertions for the retired `/agents/cmo/<id>/mcp` path
- `apps/web/app/(app)/team/_components/team-desk.tsx` — swap `clientRef.current.*` → `stub.*`, drop the `createCmoClient()` effect, use `useCmoStub`
- `apps/web/app/(app)/team/_components/teammate-transcript-drawer.tsx` — same pattern
- `apps/web/app/(app)/briefing/_components/today-tab.tsx` — same pattern; needs `userId` + `coreHost` plumbed via page
- `apps/web/app/(app)/briefing/_components/plan-tab.tsx` — same pattern
- `apps/web/app/(app)/briefing/_components/history-tab.tsx` — same pattern
- `apps/web/app/(app)/briefing/_components/briefing-header.tsx` — derived count; depends on today-tab's data shape
- `apps/web/app/(app)/briefing/page.tsx` — add session lookup, pass `userId` + `coreHost` to TodayTab/PlanTab/HistoryTab
- `apps/web/app/(app)/growth/reddit-channels/page.tsx` — pass `userId` + `coreHost` to RedditChannelsContent
- `apps/web/app/(app)/growth/reddit-channels/reddit-channels-content.tsx` — same client-side pattern as above

**Create**
- `apps/web/src/hooks/use-cmo-stub.ts` — typed wrapper around `useAgent.call()` returning `{ stub, ready, error }`
- `packages/shared/src/cmo-callable.ts` — typed interface for the 13 callables + the row shapes the browser consumes
- `apps/core/test/cmo-callable.test.ts` — per-method unit tests (one isolated DO per test, mirror cmo-memory.test.ts pattern)

**Delete**
- `apps/web/src/lib/mcp-client.ts`
- `apps/web/app/api/mcp-token/route.ts`

---

## Tasks

### Task 1: Add typed callable surface to `@shipflare/shared`

**Why:** apps/web cannot import `CMO` directly (cross-package source dep we don't want). A typed interface in `@shipflare/shared` defines the wire shapes once; `useCmoStub` uses it for typed `.call()`, CMO's `@callable` methods conform to it.

**Files:**
- Create: `packages/shared/src/cmo-callable.ts`
- Modify: `packages/shared/src/index.ts:1-6` (add export)

- [ ] **Step 1: Create `packages/shared/src/cmo-callable.ts` with the row shapes + callable signatures**

```typescript
/**
 * Wire shapes for CMO's @callable RPC surface.
 *
 * Defines the 13 callables the browser invokes via
 * `useAgent({agent:'cmo'}).call(...)` (see useCmoStub in apps/web). The
 * CMO class in apps/core implements these as @callable methods; this
 * interface is the contract.
 *
 * Cross-package source dependencies are avoided: apps/web imports types
 * from here, not from apps/core.
 */

import type { RoleSlug } from "./role-registry";

export interface PlanItemRow {
  id: string;
  skill: string;
  channel: string;
  params_json: string;
  status: string;
  owner_role: string;
  scheduled_for: number | null;
  started_at: number | null;
  completed_at: number | null;
}

export interface DraftRow {
  id: string;
  draft_id: string;
  employee: string;
  kind: string;
  channel: string;
  preview: string;
  created_at: number;
  decided_at: number | null;
  decision: string | null;
}

export interface MemoryRow {
  id: string;
  content: string;
  added_at: number;
  source_conversation_id: string | null;
}

export interface AgentTranscriptRow {
  id: number;
  conversation_id: string | null;
  from_role: string;
  kind: string;
  summary: string | null;
  payload_json: string | null;
  ts: number;
}

export interface ConversationRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  title: string | null;
}

export interface RosterRow {
  role: RoleSlug;
  status: "active";
  hired_at: number;
  hire_config_json: string | null;
}

export interface CmoCallableSurface {
  queryFounderContext(): Promise<Record<string, string>>;
  queryPlanItems(opts?: {
    status?: string;
    ownerRole?: string;
    limit?: number;
  }): Promise<PlanItemRow[]>;
  cancelPlanItem(args: { id: string }): Promise<{ id: string; status: "cancelled" }>;
  approveDraft(args: { draftId: string }): Promise<{ draftId: string; decision: "approved" }>;
  rejectDraft(args: { draftId: string; reason?: string }): Promise<{
    draftId: string;
    decision: "rejected";
  }>;
  queryDrafts(opts?: { limit?: number }): Promise<DraftRow[]>;
  rememberThis(args: {
    content: string;
    sourceConversationId?: string;
    sourceMessageTs?: number;
  }): Promise<{ id: string; ok: true }>;
  forgetThis(args: { id: string }): Promise<{ id: string; ok: true }>;
  queryMemory(opts?: { limit?: number }): Promise<MemoryRow[]>;
  queryAgentTranscript(args: {
    role: string;
    limit?: number;
  }): Promise<AgentTranscriptRow[]>;
  queryRoster(): Promise<RosterRow[]>;
  listConversations(opts?: { limit?: number }): Promise<ConversationRow[]>;
  startNewConversation(args?: { title?: string }): Promise<{ conversationId: string }>;
}
```

- [ ] **Step 2: Re-export from the package barrel**

Edit `packages/shared/src/index.ts` — add the line below before the existing `export * from "./telemetry";`:

```typescript
export * from "./cmo-callable";
```

- [ ] **Step 3: Type-check the package**

Run: `pnpm --filter @shipflare/shared exec tsc --noEmit`
Expected: exit 0, no diagnostics.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/cmo-callable.ts packages/shared/src/index.ts
git commit -m "feat(shared): cmo-callable typed wire shapes

Defines CmoCallableSurface + 6 row interfaces for CMO's @callable RPC
surface. apps/web imports types from here, not from apps/core source,
so we keep package boundaries clean."
```

---

### Task 2: Extract `_impl` methods + add @callable wrappers — read group

**Why:** 5 read-only callables share their SQL with the AI-SDK tool definitions. Extract each `execute` body to a private method, then both the tool and `@callable` delegate to it. Single source of truth per surface.

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts` (around lines 177-302, 499-553)

- [ ] **Step 1: Add the import for `callable`**

Edit `apps/core/src/agents/cmo/CMO.ts:1`:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
```

Verify the existing `AIChatAgent` import is left intact.

- [ ] **Step 2: Add 5 `_impl` private methods + 5 `@callable` public methods after `getTools()` (around line 555)**

Locate the closing brace of `getTools()` (currently around line 555 — right before `async fetch(request: Request)` at line 568). Insert the following block immediately AFTER `getTools()`:

```typescript
	// ──────────────────────────────────────────────────────────────────────
	// @callable RPC surface — read group
	//
	// Each method has an `_impl` companion that the AI-SDK `tool({...})`
	// definitions in `getTools()` also delegate to. One SQL implementation,
	// two entry points: the LLM via `tool()`, the browser via `@callable`.
	//
	// Browser auth: every connection to this DO is JWT-verified by
	// `handleCmoWsRequest` (apps/core/src/index.ts) which enforces
	// claims.name === this.name. No per-method auth check needed.
	// ──────────────────────────────────────────────────────────────────────

	private async _queryFounderContext(): Promise<Record<string, string>> {
		this.ensureSchema();
		const rows = this.ctx.storage.sql
			.exec<{ key: string; value: string }>(
				"SELECT key, value FROM founder_context",
			)
			.toArray();
		return Object.fromEntries(rows.map((r) => [r.key, r.value]));
	}

	@callable()
	async queryFounderContext(): Promise<Record<string, string>> {
		return this._queryFounderContext();
	}

	private async _queryPlanItems(args: {
		status?: string;
		ownerRole?: string;
		limit?: number;
	}): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
		let q =
			"SELECT id, skill, channel, params_json, status, owner_role, scheduled_for, started_at, completed_at FROM plan_items WHERE 1=1";
		const bindings: unknown[] = [];
		if (args.status) {
			q += " AND status = ?";
			bindings.push(args.status);
		}
		if (args.ownerRole) {
			q += " AND owner_role = ?";
			bindings.push(args.ownerRole);
		}
		q +=
			" ORDER BY scheduled_for IS NULL, scheduled_for ASC, plan_version ASC LIMIT ?";
		bindings.push(limit);
		return this.ctx.storage.sql
			.exec(q, ...(bindings as SqlStorageValue[]))
			.toArray();
	}

	@callable()
	async queryPlanItems(args: {
		status?: string;
		ownerRole?: string;
		limit?: number;
	} = {}): Promise<unknown[]> {
		return this._queryPlanItems(args);
	}

	private async _queryDrafts(args: { limit?: number }): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
		return this.ctx.storage.sql
			.exec(
				`SELECT id, draft_id, employee, kind, channel, preview, created_at, decided_at, decision
				 FROM approval_queue
				 ORDER BY created_at DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();
	}

	@callable()
	async queryDrafts(args: { limit?: number } = {}): Promise<unknown[]> {
		return this._queryDrafts(args);
	}

	private async _queryMemory(args: { limit?: number }): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
		return this.ctx.storage.sql
			.exec<{
				id: string;
				content: string;
				added_at: number;
				source_conversation_id: string | null;
			}>(
				`SELECT id, content, added_at, source_conversation_id
				 FROM cross_conversation_memory
				 WHERE active = 1
				 ORDER BY added_at DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();
	}

	@callable()
	async queryMemory(args: { limit?: number } = {}): Promise<unknown[]> {
		return this._queryMemory(args);
	}

	private async _queryAgentTranscript(args: {
		role: string;
		limit?: number;
	}): Promise<unknown[]> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
		return this.ctx.storage.sql
			.exec<{
				id: number;
				conversation_id: string | null;
				from_role: string;
				kind: string;
				summary: string | null;
				payload_json: string | null;
				ts: number;
			}>(
				`SELECT id, conversation_id, from_role, kind, summary, payload_json, ts
				 FROM employee_log
				 WHERE from_role = ?
				 ORDER BY ts DESC
				 LIMIT ?`,
				args.role,
				limit,
			)
			.toArray();
	}

	@callable()
	async queryAgentTranscript(args: {
		role: string;
		limit?: number;
	}): Promise<unknown[]> {
		return this._queryAgentTranscript(args);
	}
```

- [ ] **Step 3: Rewrite the 5 tool `execute` bodies to delegate**

Find each of these tool definitions inside `getTools()` and replace the `execute` arrow body with a delegating call. Keep `description`, `inputSchema`, and all other fields intact.

Replace at `CMO.ts` queryFounderContext (around line 181):

```typescript
				execute: async () => self._queryFounderContext(),
```

Replace at `CMO.ts` queryPlanItems (around line 282):

```typescript
				execute: async (args) => self._queryPlanItems(args),
```

Replace at `CMO.ts` queryDrafts (around line 434):

```typescript
				execute: async (args) => self._queryDrafts(args),
```

Replace at `CMO.ts` queryMemory (around line 504):

```typescript
				execute: async (args) => self._queryMemory(args),
```

Replace at `CMO.ts` queryAgentTranscript (around line 531):

```typescript
				execute: async (args) => self._queryAgentTranscript(args),
```

- [ ] **Step 4: Verify the experimental decorators flag is enabled in tsconfig**

Decorators on class methods require `experimentalDecorators: true` in tsconfig, OR ES2022 stage-3 decorators support (the agents SDK uses the stage-3 form per its `_context: ClassMethodDecoratorContext` signature). Check `apps/core/tsconfig.json`:

Run: `grep -n 'target\|module\|decorator' /Users/yifeng/Documents/Code/shipflare/apps/core/tsconfig.json`

If `experimentalDecorators` is set to `true`, REMOVE that line — the stage-3 decorator the SDK uses is INCOMPATIBLE with `experimentalDecorators`. If `target` is anything below `ES2022`, set it to `ES2022` (stage-3 decorators require it).

If those settings need changing, edit `apps/core/tsconfig.json` accordingly. Otherwise this step is a no-op.

- [ ] **Step 5: Type-check apps/core**

Run: `pnpm --filter @shipflare/core exec tsc --noEmit`
Expected: exit 0, no diagnostics. If decorators error, revisit Step 4.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts
git commit -m "feat(cmo): @callable read surface (5 methods)

Extracts _queryFounderContext/_queryPlanItems/_queryDrafts/_queryMemory/
_queryAgentTranscript as private impls; both the AI-SDK tool defs and
new @callable methods delegate to them. One SQL impl per surface."
```

---

### Task 3: Extract `_impl` methods + add @callable wrappers — write group

**Why:** 5 mutating callables share their SQL with AI-SDK tools the same way. Same pattern as Task 2; pulled out separately so each commit is one logical change.

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts` (around lines 343-497)

- [ ] **Step 1: Add 5 `_impl` private methods + 5 `@callable` public methods, after the read group inserted in Task 2**

Append AFTER the `queryAgentTranscript` callable from Task 2 (still before `async fetch(request: Request)`):

```typescript
	// ──────────────────────────────────────────────────────────────────────
	// @callable RPC surface — write group
	// ──────────────────────────────────────────────────────────────────────

	private async _cancelPlanItem(args: {
		id: string;
	}): Promise<{ id: string; status: "cancelled" }> {
		this.ensureSchema();
		const now = Date.now();
		const existing = this.ctx.storage.sql
			.exec<{ id: string; status: string }>(
				"SELECT id, status FROM plan_items WHERE id = ?",
				args.id,
			)
			.toArray();
		const row = existing[0];
		if (!row) {
			throw new Error(`plan_item not found: ${args.id}`);
		}
		if (
			row.status === "completed" ||
			row.status === "failed" ||
			row.status === "cancelled"
		) {
			throw new Error(
				`plan_item ${args.id} is already terminal (${row.status}); cannot cancel`,
			);
		}
		this.ctx.storage.sql.exec(
			`UPDATE plan_items
			 SET status = 'cancelled', completed_at = ?
			 WHERE id = ?`,
			now,
			args.id,
		);
		return { id: args.id, status: "cancelled" as const };
	}

	@callable()
	async cancelPlanItem(args: {
		id: string;
	}): Promise<{ id: string; status: "cancelled" }> {
		return this._cancelPlanItem(args);
	}

	private async _approveDraft(args: {
		draftId: string;
	}): Promise<{ draftId: string; decision: "approved" }> {
		this.ensureSchema();
		const result = this.ctx.storage.sql.exec(
			`UPDATE approval_queue
			 SET decided_at = ?, decision = 'approved'
			 WHERE draft_id = ?`,
			Date.now(),
			args.draftId,
		);
		if (result.rowsWritten === 0) {
			throw new Error(`draft not in approval_queue: ${args.draftId}`);
		}
		return { draftId: args.draftId, decision: "approved" as const };
	}

	@callable()
	async approveDraft(args: {
		draftId: string;
	}): Promise<{ draftId: string; decision: "approved" }> {
		return this._approveDraft(args);
	}

	private async _rejectDraft(args: {
		draftId: string;
		reason?: string;
	}): Promise<{ draftId: string; decision: "rejected" }> {
		this.ensureSchema();
		const result = this.ctx.storage.sql.exec(
			`UPDATE approval_queue
			 SET decided_at = ?, decision = 'rejected'
			 WHERE draft_id = ?`,
			Date.now(),
			args.draftId,
		);
		if (result.rowsWritten === 0) {
			throw new Error(`draft not in approval_queue: ${args.draftId}`);
		}
		return { draftId: args.draftId, decision: "rejected" as const };
	}

	@callable()
	async rejectDraft(args: {
		draftId: string;
		reason?: string;
	}): Promise<{ draftId: string; decision: "rejected" }> {
		return this._rejectDraft(args);
	}

	private async _rememberThis(args: {
		content: string;
		sourceConversationId?: string;
		sourceMessageTs?: number;
	}): Promise<{ id: string; ok: true }> {
		this.ensureSchema();
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			`INSERT INTO cross_conversation_memory
			   (id, content, source_conversation_id, source_message_ts, added_at, active)
			 VALUES (?, ?, ?, ?, ?, 1)`,
			id,
			args.content,
			args.sourceConversationId ?? null,
			args.sourceMessageTs ?? null,
			Date.now(),
		);
		return { id, ok: true as const };
	}

	@callable()
	async rememberThis(args: {
		content: string;
		sourceConversationId?: string;
		sourceMessageTs?: number;
	}): Promise<{ id: string; ok: true }> {
		return this._rememberThis(args);
	}

	private async _forgetThis(args: {
		id: string;
	}): Promise<{ id: string; ok: true }> {
		this.ensureSchema();
		const result = this.ctx.storage.sql.exec(
			"UPDATE cross_conversation_memory SET active = 0 WHERE id = ?",
			args.id,
		);
		if (result.rowsWritten === 0) {
			throw new Error(`memory not found: ${args.id}`);
		}
		return { id: args.id, ok: true as const };
	}

	@callable()
	async forgetThis(args: { id: string }): Promise<{ id: string; ok: true }> {
		return this._forgetThis(args);
	}
```

- [ ] **Step 2: Rewrite the 5 tool `execute` bodies to delegate**

Replace at `CMO.ts` cancelPlanItem (around line 349):

```typescript
				execute: async (args) => self._cancelPlanItem(args),
```

Replace at `CMO.ts` approveDraft (around line 388):

```typescript
				execute: async (args) => self._approveDraft(args),
```

Replace at `CMO.ts` rejectDraft (around line 412):

```typescript
				execute: async (args) => self._rejectDraft(args),
```

Replace at `CMO.ts` rememberThis (around line 463):

```typescript
				execute: async (args) => self._rememberThis(args),
```

Replace at `CMO.ts` forgetThis (around line 486):

```typescript
				execute: async (args) => self._forgetThis(args),
```

- [ ] **Step 3: Type-check apps/core**

Run: `pnpm --filter @shipflare/core exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts
git commit -m "feat(cmo): @callable write surface (5 methods)

Same pattern as the read group — extracted _cancelPlanItem,
_approveDraft, _rejectDraft, _rememberThis, _forgetThis as shared
implementations behind both the AI-SDK tool def and the new @callable."
```

---

### Task 4: Add `conversations` table to CMO schema

**Why:** AIChatAgent's `cf_ai_chat_agent_messages` is one bag per DO, not per-conversation. `useAgentChat({ id })` does not partition storage. To support a multi-thread UI in `/team`, we need an authoritative conversation list — a small new table on CMO's per-team SQLite.

**Files:**
- Modify: `apps/core/src/agents/cmo/schema.ts`

- [ ] **Step 1: Replace the schema-header comment to clarify why `conversations` came back**

Edit `apps/core/src/agents/cmo/schema.ts:11-18` (the "Post-Phase-5 changes" block). Replace those lines with:

```typescript
 * Post-Phase-5 changes (Task 5.1b of CF-native chat migration):
 *  - DROPPED: `founder_messages` — chat history is persisted by AIChatAgent's
 *    built-in `cf_ai_chat_agent_messages` table on first chat. Spec §2 confirms (Q3=B).
 *  - DROPPED: `roster` — per-user hiring retired. EMPLOYEE_REGISTRY is the
 *    static org chart; every peer always available via `consult`. queryRoster
 *    derives from the registry (Task #11, 2026-05-19).
 *  - DROPPED: `activity_events` — the bespoke activity feed is replaced by
 *    Analytics Engine via `writeAgentEvent` (Phase 0 telemetry).
 *
 * Post-Task-#11 (2026-05-19):
 *  - RESTORED: `conversations` — AIChatAgent's cf_ai_chat_agent_messages is
 *    one bag per DO; `useAgentChat({id})` doesn't partition storage. The
 *    founder UI needs an authoritative thread list, so we keep this small
 *    table on per-team SQLite. startNewConversation INSERTs; listConversations
 *    READs. Threads themselves are still rendered from the AIChatAgent bag
 *    (filtered client-side by id at render time).
 */
```

- [ ] **Step 2: Append the `conversations` table CREATE to `applyCmoSchema`**

At the end of the SQL block inside `applyCmoSchema` (just before the closing backtick at line ~139), append:

```sql
    -- Founder-facing conversation thread list (Task #11, 2026-05-19).
    -- AIChatAgent stores all messages in one cf_ai_chat_agent_messages bag
    -- per DO; this table is the authoritative thread index the /team UI
    -- enumerates via listConversations. startNewConversation INSERTs a row;
    -- the resulting id is passed to useAgentChat({id}) so the client can
    -- key its message-list rendering.
    CREATE TABLE IF NOT EXISTS conversations (
      id           TEXT PRIMARY KEY,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      title        TEXT,
      archived_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_active
      ON conversations(archived_at, started_at DESC);
```

- [ ] **Step 3: Add a schema test for the new table**

Append to `apps/core/test/cmo-schema.test.ts`:

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

it("creates conversations table with the expected columns", async () => {
  const stub = env.CMO.getByName("schema-conv-1");
  await runInDurableObject(stub, async (_instance: CMO, state) => {
    applyCmoSchema(state.storage.sql);
    const cols = state.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(conversations)")
      .toArray()
      .map((r) => r.name);
    expect(cols).toEqual([
      "id",
      "started_at",
      "ended_at",
      "title",
      "archived_at",
    ]);
  });
});
```

If `cmo-schema.test.ts` doesn't exist yet, create it with the imports above + the test wrapped in a `describe("CMO schema", () => { ... })`.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @shipflare/core exec vitest run cmo-schema.test.ts -t "conversations table"`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @shipflare/core exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/agents/cmo/schema.ts apps/core/test/cmo-schema.test.ts
git commit -m "feat(cmo): conversations table for multi-thread UI"
```

---

### Task 5: Add conversation + roster @callable methods

**Why:** Three net-new methods round out the surface. `startNewConversation` + `listConversations` use the new table from Task 4. `queryRoster` derives statically from `EMPLOYEE_REGISTRY`.

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts`

- [ ] **Step 1: Add import for EMPLOYEE_REGISTRY**

Edit `apps/core/src/agents/cmo/CMO.ts:1-28` (the import block). After the existing `import { handleInternalJson } from ...` add:

```typescript
import { EMPLOYEE_REGISTRY } from "../registry";
```

- [ ] **Step 2: Append 3 new @callable methods after the Task 3 write group**

Insert AFTER the `forgetThis` callable from Task 3 (still before `async fetch(request: Request)`):

```typescript
	// ──────────────────────────────────────────────────────────────────────
	// @callable RPC surface — conversations + roster
	// ──────────────────────────────────────────────────────────────────────

	@callable()
	async startNewConversation(args: { title?: string } = {}): Promise<{
		conversationId: string;
	}> {
		this.ensureSchema();
		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			`INSERT INTO conversations (id, started_at, title)
			 VALUES (?, ?, ?)`,
			id,
			Date.now(),
			args.title ?? null,
		);
		return { conversationId: id };
	}

	@callable()
	async listConversations(args: { limit?: number } = {}): Promise<
		Array<{
			id: string;
			started_at: number;
			ended_at: number | null;
			title: string | null;
		}>
	> {
		this.ensureSchema();
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
		return this.ctx.storage.sql
			.exec<{
				id: string;
				started_at: number;
				ended_at: number | null;
				title: string | null;
			}>(
				`SELECT id, started_at, ended_at, title
				 FROM conversations
				 WHERE archived_at IS NULL
				 ORDER BY started_at DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();
	}

	/**
	 * Static roster derived from EMPLOYEE_REGISTRY.
	 *
	 * Post-rewrite (f61362ae) the per-team `roster` table was dropped:
	 * EMPLOYEE_REGISTRY is the static org chart and every employee is
	 * always available via `consult`. hireEmployee / fireEmployee are
	 * not exposed on the @callable surface for this reason.
	 *
	 * EmployeeId in registry is the short slug (cmo / hog / smm); the
	 * /team UI matches against ROLE_REGISTRY (full slug like
	 * `head-of-growth`). Map short→full for wire compat.
	 */
	@callable()
	async queryRoster(): Promise<
		Array<{
			role: string;
			status: "active";
			hired_at: number;
			hire_config_json: null;
		}>
	> {
		this.ensureSchema();
		const createdAtRow = this.ctx.storage.sql
			.exec<{ value: string }>(
				"SELECT value FROM founder_context WHERE key = 'created_at' LIMIT 1",
			)
			.toArray();
		const hiredAt = createdAtRow[0]?.value
			? Number(createdAtRow[0].value)
			: Date.now();
		const SLUG_MAP: Record<string, string> = {
			cmo: "cmo",
			hog: "head-of-growth",
			smm: "social-media-manager",
		};
		return Object.keys(EMPLOYEE_REGISTRY).map((shortId) => ({
			role: SLUG_MAP[shortId] ?? shortId,
			status: "active" as const,
			hired_at: hiredAt,
			hire_config_json: null,
		}));
	}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @shipflare/core exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts
git commit -m "feat(cmo): @callable startNewConversation + listConversations + queryRoster"
```

---

### Task 6: Per-method unit tests for the @callable surface

**Why:** Each callable has documented failure modes. Lock the behaviour in vitest-pool-workers before browser migration starts.

**Files:**
- Create: `apps/core/test/cmo-callable.test.ts`
- Modify: `apps/core/test/agents/cmo.test.ts`

- [ ] **Step 1: Create the test file**

Write to `apps/core/test/cmo-callable.test.ts`:

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import type { CMO } from "../src/agents/cmo/CMO";

describe("CMO @callable surface", () => {
  describe("queryRoster", () => {
    it("returns 3 active employees derived from EMPLOYEE_REGISTRY", async () => {
      const stub = env.CMO.getByName("cb-roster-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const rows = await instance.queryRoster();
        expect(rows).toHaveLength(3);
        const roles = rows.map((r) => r.role).sort();
        expect(roles).toEqual([
          "cmo",
          "head-of-growth",
          "social-media-manager",
        ]);
        expect(rows.every((r) => r.status === "active")).toBe(true);
      });
    });
  });

  describe("startNewConversation + listConversations", () => {
    it("INSERT round-trips via listConversations newest-first", async () => {
      const stub = env.CMO.getByName("cb-conv-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const a = await instance.startNewConversation({ title: "first" });
        const b = await instance.startNewConversation();
        const list = await instance.listConversations();
        expect(list).toHaveLength(2);
        expect(list[0]?.id).toBe(b.conversationId);
        expect(list[1]?.id).toBe(a.conversationId);
        expect(list[1]?.title).toBe("first");
      });
    });

    it("limit param clamps between 1 and 100", async () => {
      const stub = env.CMO.getByName("cb-conv-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await instance.startNewConversation();
        const tooSmall = await instance.listConversations({ limit: 0 });
        const tooBig = await instance.listConversations({ limit: 99999 });
        expect(tooSmall).toHaveLength(1);
        expect(tooBig).toHaveLength(1);
      });
    });
  });

  describe("queryDrafts + approveDraft + rejectDraft", () => {
    it("approveDraft flips decision on matching row", async () => {
      const stub = env.CMO.getByName("cb-draft-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "row-1",
          "draft-1",
          "smm",
          "post",
          "x",
          "preview",
          Date.now(),
        );
        const out = await instance.approveDraft({ draftId: "draft-1" });
        expect(out).toEqual({ draftId: "draft-1", decision: "approved" });
        const drafts = await instance.queryDrafts();
        expect(drafts).toHaveLength(1);
        expect((drafts[0] as { decision: string }).decision).toBe("approved");
      });
    });

    it("approveDraft throws on unknown draftId", async () => {
      const stub = env.CMO.getByName("cb-draft-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await expect(
          instance.approveDraft({ draftId: "no-such" }),
        ).rejects.toThrow("not in approval_queue");
      });
    });

    it("rejectDraft flips decision; tolerates optional reason", async () => {
      const stub = env.CMO.getByName("cb-draft-3");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO approval_queue (id, draft_id, employee, kind, channel, preview, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "row-r",
          "draft-r",
          "smm",
          "post",
          "x",
          "preview",
          Date.now(),
        );
        const out = await instance.rejectDraft({ draftId: "draft-r", reason: "bad voice" });
        expect(out).toEqual({ draftId: "draft-r", decision: "rejected" });
      });
    });
  });

  describe("queryPlanItems + cancelPlanItem", () => {
    it("cancelPlanItem flips status to cancelled + stamps completed_at", async () => {
      const stub = env.CMO.getByName("cb-plan-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
          "plan-1",
          "draft-post",
          "x",
          "{}",
          "smm",
        );
        const out = await instance.cancelPlanItem({ id: "plan-1" });
        expect(out).toEqual({ id: "plan-1", status: "cancelled" });
        const items = await instance.queryPlanItems({});
        expect((items[0] as { status: string }).status).toBe("cancelled");
        expect((items[0] as { completed_at: number }).completed_at).toBeGreaterThan(0);
      });
    });

    it("cancelPlanItem throws on terminal status", async () => {
      const stub = env.CMO.getByName("cb-plan-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role, completed_at)
           VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
          "plan-done",
          "draft-post",
          "x",
          "{}",
          "smm",
          Date.now(),
        );
        await expect(
          instance.cancelPlanItem({ id: "plan-done" }),
        ).rejects.toThrow("already terminal");
      });
    });

    it("queryPlanItems filters by status + ownerRole", async () => {
      const stub = env.CMO.getByName("cb-plan-3");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const insert = (id: string, status: string, role: string) =>
          state.storage.sql.exec(
            `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role)
             VALUES (?, 'draft-post', 'x', '{}', ?, ?)`,
            id, status, role,
          );
        insert("p1", "pending", "smm");
        insert("p2", "completed", "smm");
        insert("p3", "pending", "hog");
        expect((await instance.queryPlanItems({ status: "pending" }))).toHaveLength(2);
        expect((await instance.queryPlanItems({ ownerRole: "smm" }))).toHaveLength(2);
        expect(
          (await instance.queryPlanItems({ status: "pending", ownerRole: "smm" })),
        ).toHaveLength(1);
      });
    });
  });

  describe("rememberThis + queryMemory + forgetThis", () => {
    it("INSERT + filter active=1 + soft-delete cycle", async () => {
      const stub = env.CMO.getByName("cb-mem-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const a = await instance.rememberThis({ content: "voice: terse" });
        const b = await instance.rememberThis({ content: "audience: founders" });
        expect((await instance.queryMemory()).length).toBe(2);
        await instance.forgetThis({ id: a.id });
        const after = await instance.queryMemory();
        expect(after).toHaveLength(1);
        expect((after[0] as { id: string }).id).toBe(b.id);
      });
    });

    it("forgetThis throws on unknown id", async () => {
      const stub = env.CMO.getByName("cb-mem-2");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        await expect(instance.forgetThis({ id: "nope" })).rejects.toThrow(
          "memory not found",
        );
      });
    });
  });

  describe("queryFounderContext + queryAgentTranscript", () => {
    it("queryFounderContext returns the KV map", async () => {
      const stub = env.CMO.getByName("cb-ctx-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        state.storage.sql.exec(
          "INSERT INTO founder_context (key, value) VALUES (?, ?), (?, ?)",
          "productName", "ShipFlare",
          "voice", "terse",
        );
        const ctx = await instance.queryFounderContext();
        expect(ctx).toEqual({ productName: "ShipFlare", voice: "terse" });
      });
    });

    it("queryAgentTranscript filters by role + caps limit", async () => {
      const stub = env.CMO.getByName("cb-tx-1");
      await runInDurableObject(stub, async (instance: CMO, state) => {
        applyCmoSchema(state.storage.sql);
        const insert = (role: string, summary: string, ts: number) =>
          state.storage.sql.exec(
            `INSERT INTO employee_log (from_role, kind, summary, ts)
             VALUES (?, 'task', ?, ?)`,
            role, summary, ts,
          );
        insert("smm", "draft a", 1000);
        insert("smm", "draft b", 2000);
        insert("hog", "research", 1500);
        const rows = await instance.queryAgentTranscript({ role: "smm" });
        expect(rows).toHaveLength(2);
        expect((rows[0] as { summary: string }).summary).toBe("draft b");
      });
    });
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `pnpm --filter @shipflare/core exec vitest run cmo-callable.test.ts`
Expected: all PASS.

- [ ] **Step 3: Append callable-surface assertion to existing cmo.test.ts**

After the existing `it("getTools() exposes consult + 14 shared-state tools", ...)` block in `apps/core/test/agents/cmo.test.ts`, append:

```typescript
	it("exposes 13 @callable methods on the public surface", async () => {
		const id = env.CMO.idFromName("cmo-test-callables");
		await runInDurableObject<CMO, void>(env.CMO.get(id), async (instance) => {
			const expected = [
				"queryFounderContext",
				"queryPlanItems",
				"cancelPlanItem",
				"approveDraft",
				"rejectDraft",
				"queryDrafts",
				"rememberThis",
				"forgetThis",
				"queryMemory",
				"queryAgentTranscript",
				"queryRoster",
				"listConversations",
				"startNewConversation",
			];
			for (const name of expected) {
				expect(typeof (instance as unknown as Record<string, unknown>)[name]).toBe("function");
			}
		});
	});
```

- [ ] **Step 4: Run the smoke test**

Run: `pnpm --filter @shipflare/core exec vitest run agents/cmo.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/test/cmo-callable.test.ts apps/core/test/agents/cmo.test.ts
git commit -m "test(cmo): @callable surface coverage"
```

---

### Task 7: useCmoStub hook in apps/web

**Why:** Browser-side typed access to the 13 callables, sharing the WS connection with `useCmoChat`.

**Files:**
- Create: `apps/web/src/hooks/use-cmo-stub.ts`

- [ ] **Step 1: Write the hook**

Create `apps/web/src/hooks/use-cmo-stub.ts`:

```typescript
"use client";

import { useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import type {
  CmoCallableSurface,
  PlanItemRow,
  DraftRow,
  MemoryRow,
  AgentTranscriptRow,
  ConversationRow,
  RosterRow,
} from "@shipflare/shared";

async function fetchAgentJwt(agent: string, name?: string): Promise<string> {
  if (typeof window === "undefined") return "";
  const url = name
    ? `/api/agent-token?agent=${agent}&name=${encodeURIComponent(name)}`
    : `/api/agent-token?agent=${agent}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch agent JWT: ${res.status} ${res.statusText}`,
    );
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

export interface UseCmoStubResult {
  stub: CmoCallableSurface;
  ready: Promise<void>;
  error: string | null;
}

export function useCmoStub({
  userId,
  coreHost,
}: {
  userId: string;
  coreHost?: string;
}): UseCmoStubResult {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const agent = useAgent({
    agent: "cmo",
    name: userId,
    host: coreHost,
    query: async () => ({
      token: await fetchAgentJwt("cmo", userId),
      tz,
    }),
    queryDeps: [userId, tz],
  });

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onErr = (ev: Event) => {
      setError(ev instanceof ErrorEvent ? ev.message : "WebSocket error");
    };
    agent.addEventListener("error", onErr as EventListener);
    return () => agent.removeEventListener("error", onErr as EventListener);
  }, [agent]);

  const stub = useMemo<CmoCallableSurface>(() => {
    const call = <T>(method: string, args?: unknown[]): Promise<T> =>
      agent.call<T>(method, args ?? []);

    return {
      queryFounderContext: () => call<Record<string, string>>("queryFounderContext"),
      queryPlanItems: (opts = {}) => call<PlanItemRow[]>("queryPlanItems", [opts]),
      cancelPlanItem: (args) => call<{ id: string; status: "cancelled" }>("cancelPlanItem", [args]),
      approveDraft: (args) => call<{ draftId: string; decision: "approved" }>("approveDraft", [args]),
      rejectDraft: (args) => call<{ draftId: string; decision: "rejected" }>("rejectDraft", [args]),
      queryDrafts: (opts = {}) => call<DraftRow[]>("queryDrafts", [opts]),
      rememberThis: (args) => call<{ id: string; ok: true }>("rememberThis", [args]),
      forgetThis: (args) => call<{ id: string; ok: true }>("forgetThis", [args]),
      queryMemory: (opts = {}) => call<MemoryRow[]>("queryMemory", [opts]),
      queryAgentTranscript: (args) => call<AgentTranscriptRow[]>("queryAgentTranscript", [args]),
      queryRoster: () => call<RosterRow[]>("queryRoster"),
      listConversations: (opts = {}) => call<ConversationRow[]>("listConversations", [opts]),
      startNewConversation: (args = {}) => call<{ conversationId: string }>("startNewConversation", [args]),
    };
  }, [agent]);

  return { stub, ready: agent.ready, error };
}
```

- [ ] **Step 2: Type-check apps/web**

Run: `pnpm --filter @shipflare/web exec tsc --noEmit`
Expected: exit 0. If `agent.call`'s generic doesn't accept `<T>`, switch to the untyped form and cast at each site (e.g. `agent.call("queryRoster", []) as Promise<RosterRow[]>`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/use-cmo-stub.ts
git commit -m "feat(web): useCmoStub — typed @callable RPC for CMO"
```

---

### Task 8: Migrate team-desk.tsx to useCmoStub

**Why:** Heaviest user of the old surface (9 method calls). Migrate first to flush out issues.

**Files:**
- Modify: `apps/web/app/(app)/team/_components/team-desk.tsx`

- [ ] **Step 1: Replace imports**

Replace the line:
```typescript
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";
```
with:
```typescript
import { useCmoStub } from "@/hooks/use-cmo-stub";
```

Delete the `clientRef` line (`const clientRef = useRef<CmoClient | null>(null);`).

- [ ] **Step 2: Add useCmoStub call near useCmoChat**

After the existing `useCmoChat({ ... })` destructuring (around line 183-192), add:

```typescript
  const { stub, ready: stubReady, error: stubError } = useCmoStub({
    userId: user.id,
    coreHost,
  });
```

- [ ] **Step 3: Replace the connect/init useEffect**

Replace the useEffect at lines ~106-172 (the one starting with `let cancelled = false;` + `createCmoClient()`) with:

```typescript
  useEffect(() => {
    let cancelled = false;
    void stubReady.then(async () => {
      if (cancelled) return;
      try {
        const [rosterRaw, convList, items, pendingDrafts] = await Promise.all([
          stub.queryRoster(),
          stub.listConversations({ limit: 20 }),
          stub.queryPlanItems({ limit: 50 }),
          stub.queryDrafts({ limit: 20 }),
        ]);
        if (cancelled) return;
        const activeStatuses = new Set([
          "pending",
          "drafting",
          "executing",
          "in_progress",
        ]);
        const counts = new Map<string, number>();
        for (const item of items) {
          const role = (item as { owner_role?: string }).owner_role;
          const status = (item as { status?: string }).status;
          if (!role || !status) continue;
          if (!activeStatuses.has(status)) continue;
          counts.set(role, (counts.get(role) ?? 0) + 1);
        }
        setEmployees(
          rosterRaw.map((raw) => {
            const base = toRosterEmployee(raw);
            return { ...base, taskCount: counts.get(base.role) ?? 0 };
          }),
        );
        setConversations(convList);
        if (convList.length > 0 && convList[0]) {
          setSelectedConversationId(convList[0].id);
        }
        setPlanItems(items as PlanItemRow[]);
        setDrafts(pendingDrafts as DraftRow[]);
        setInitDone(true);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load";
        setConnectError(msg);
        setInitDone(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stub, stubReady]);
```

- [ ] **Step 4: Replace refreshPanelData (around lines 196-227)**

```typescript
  const refreshPanelData = useCallback(async () => {
    try {
      const [items, pendingDrafts] = await Promise.all([
        stub.queryPlanItems({ limit: 50 }),
        stub.queryDrafts({ limit: 20 }),
      ]);
      setPlanItems(items as PlanItemRow[]);
      setDrafts(pendingDrafts as DraftRow[]);
      const activeStatuses = new Set([
        "pending",
        "drafting",
        "executing",
        "in_progress",
      ]);
      const counts = new Map<string, number>();
      for (const item of items) {
        const role = (item as { owner_role?: string }).owner_role;
        const status = (item as { status?: string }).status;
        if (!role || !status) continue;
        if (!activeStatuses.has(status)) continue;
        counts.set(role, (counts.get(role) ?? 0) + 1);
      }
      setEmployees((prev) =>
        prev.map((e) => ({ ...e, taskCount: counts.get(e.role) ?? 0 })),
      );
    } catch {
      // non-fatal — panel will show stale data on next user action
    }
  }, [stub]);
```

- [ ] **Step 5: Replace all `clientRef.current.*` mutation handlers**

Replace `handleNewConversation`:

```typescript
  const handleNewConversation = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { conversationId } = await stub.startNewConversation();
      setSelectedConversationId(conversationId);
      const convList = await stub.listConversations({ limit: 20 });
      setConversations(convList);
    } catch {
      // Silently fail — conversation list will be stale but user can retry.
    } finally {
      setCreating(false);
    }
  }, [creating, stub]);
```

Replace `handleApproveDraft`:

```typescript
  const handleApproveDraft = useCallback(
    async (id: string) => {
      setLoadingDraftId(id);
      try {
        await stub.approveDraft({ draftId: id });
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Approve failed";
        toast(`Couldn't approve draft: ${msg}`, "error");
      } finally {
        setLoadingDraftId(null);
      }
    },
    [stub, toast],
  );
```

Replace `handleRejectDraft`:

```typescript
  const handleRejectDraft = useCallback(
    async (id: string) => {
      setLoadingDraftId(id);
      try {
        await stub.rejectDraft({ draftId: id });
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reject failed";
        toast(`Couldn't reject draft: ${msg}`, "error");
      } finally {
        setLoadingDraftId(null);
      }
    },
    [stub, toast],
  );
```

Replace `handleCancelPlanItem`:

```typescript
  const handleCancelPlanItem = useCallback(
    async (id: string) => {
      setCancellingPlanId(id);
      try {
        await stub.cancelPlanItem({ id });
        setPlanItems((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, status: "cancelled" } : p,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Cancel failed";
        toast(`Couldn't cancel task: ${msg}`, "error");
      } finally {
        setCancellingPlanId(null);
      }
    },
    [stub, toast],
  );
```

- [ ] **Step 6: Surface stubError**

Add this effect after the init effect:

```typescript
  useEffect(() => {
    if (stubError && !connectError) {
      setConnectError(stubError);
    }
  }, [stubError, connectError]);
```

- [ ] **Step 7: Type-check**

Run: `pnpm --filter @shipflare/web exec tsc --noEmit`
Expected: exit 0. Add any missing imports surfaced (PlanItemRow, DraftRow already imported via `./types`).

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/\(app\)/team/_components/team-desk.tsx
git commit -m "feat(web): /team migrates to useCmoStub"
```

---

### Task 9: Migrate teammate-transcript-drawer.tsx

**Why:** Single-method consumer (`queryAgentTranscript`) on the team page.

**Files:**
- Modify: `apps/web/app/(app)/team/_components/teammate-transcript-drawer.tsx`
- Modify: `apps/web/app/(app)/team/_components/team-desk.tsx` (pass new props)

- [ ] **Step 1: Inspect current shape**

Run: `grep -n "createCmoClient\|clientRef\|useEffect\|export function\|TeammateTranscriptDrawerProps" /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/team/_components/teammate-transcript-drawer.tsx`

- [ ] **Step 2: Add userId + coreHost to props**

Replace the existing imports + props interface. Add to the interface:

```typescript
export interface TeammateTranscriptDrawerProps {
  target: TranscriptDrawerTarget | null;
  onClose: () => void;
  userId: string;
  coreHost?: string;
  // ... keep any other existing props
}
```

Add at the top:
```typescript
import { useCmoStub } from "@/hooks/use-cmo-stub";
```

Delete the `createCmoClient`/`CmoClient` import.

- [ ] **Step 3: Replace the data-fetch effect**

Replace the effect that calls `createCmoClient()` + `queryAgentTranscript(role, 100)` with:

```typescript
const { stub, ready } = useCmoStub({ userId, coreHost });

useEffect(() => {
  if (!target) return;
  let cancelled = false;
  void ready.then(async () => {
    if (cancelled) return;
    try {
      const rows = await stub.queryAgentTranscript({
        role: target.role,
        limit: 100,
      });
      if (!cancelled) setRows(rows);
    } catch {
      // non-fatal
    }
  });
  return () => {
    cancelled = true;
  };
}, [target, stub, ready]);
```

Delete the `clientRef` declaration.

- [ ] **Step 4: Pass userId + coreHost from team-desk.tsx**

Edit `apps/web/app/(app)/team/_components/team-desk.tsx`. Find `<TeammateTranscriptDrawer` render and add:

```typescript
<TeammateTranscriptDrawer
  // ... existing props
  userId={user.id}
  coreHost={coreHost}
/>
```

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @shipflare/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(app\)/team/_components/teammate-transcript-drawer.tsx apps/web/app/\(app\)/team/_components/team-desk.tsx
git commit -m "feat(web): transcript drawer migrates to useCmoStub"
```

---

### Task 10: Migrate /briefing tabs

**Why:** All three Briefing tabs use the old CmoClient pattern. They need page-level userId + coreHost plumbing.

**Files:**
- Modify: `apps/web/app/(app)/briefing/page.tsx`
- Modify: `apps/web/app/(app)/briefing/_components/today-tab.tsx`
- Modify: `apps/web/app/(app)/briefing/_components/plan-tab.tsx`
- Modify: `apps/web/app/(app)/briefing/_components/history-tab.tsx`
- Modify: `apps/web/app/(app)/briefing/_components/briefing-header.tsx` (only if it does its own data fetch)

- [ ] **Step 1: Audit briefing/page.tsx current shape**

Run: `cat /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/briefing/page.tsx`

If it renders only `<TodayTab />`, replace with the session-plumbing version below. If it renders multiple tabs via a tab shell, keep the shell and just thread `userId` + `coreHost` to each tab.

Minimal version (single TodayTab):

```typescript
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { TodayTab } from "./_components/today-tab";

export const dynamic = "force-dynamic";

export default async function BriefingPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[BriefingPage] getSession failed", err);
  }
  if (!session?.user) return null;
  return (
    <TodayTab
      userId={session.user.id}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
```

- [ ] **Step 2: Migrate today-tab.tsx**

Add props interface:
```typescript
export interface TodayTabProps {
  userId: string;
  coreHost?: string;
}

export function TodayTab({ userId, coreHost }: TodayTabProps) {
```

Replace the `useBriefing()` extraction. Replace the `import { createCmoClient, type CmoClient } from "@/lib/mcp-client";` line with `import { useCmoStub } from "@/hooks/use-cmo-stub";`.

Inline the data-fetch into the component (delete the `useBriefing` hook function; move its body into the component scope):

```typescript
  const { stub, ready } = useCmoStub({ userId, coreHost });
  const [state, setState] = useState<BriefingState>({
    loading: true,
    error: null,
    data: null,
    approvingId: null,
  });

  useEffect(() => {
    let cancelled = false;
    void ready.then(async () => {
      if (cancelled) return;
      try {
        const pendingDrafts = (await stub.queryDrafts({ limit: 50 })) as Draft[];
        if (cancelled) return;
        setState((s) => ({
          ...s,
          loading: false,
          data: { pendingDrafts },
        }));
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, loading: false, error: msg }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stub, ready]);

  const approveDraft = useCallback(async (draftId: string) => {
    if (state.approvingId) return;
    setState((s) => ({ ...s, approvingId: draftId }));
    try {
      await stub.approveDraft({ draftId });
      const pendingDrafts = (await stub.queryDrafts({ limit: 50 })) as Draft[];
      setState((s) => ({
        ...s,
        approvingId: null,
        data: s.data ? { ...s.data, pendingDrafts } : null,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, approvingId: null, error: msg }));
    }
  }, [state.approvingId, stub]);

  const { loading, error, data, approvingId } = state;
```

**Caveat to note in the commit message:** `TodayTab`'s local `Draft` interface includes `body`, `why_it_works`, `confidence`, `status` — these don't exist on the @callable `queryDrafts` (approval_queue shape). The cards will render with these fields undefined. Acceptable for this migration; a follow-up plan can wire SMM's full draft shape through.

- [ ] **Step 3: Migrate plan-tab.tsx**

Same pattern. Add props `{ userId, coreHost }`, replace `createCmoClient`/`clientRef` with `useCmoStub`. Replace the `useEffect` at line ~249:

```typescript
  const { stub, ready } = useCmoStub({ userId, coreHost });

  useEffect(() => {
    let cancelled = false;
    void ready.then(async () => {
      if (cancelled) return;
      try {
        const items = (await stub.queryPlanItems({ limit: 500 })) as PlanItem[];
        if (cancelled) return;
        rawItemsRef.current = items;
        setState((s) => ({
          ...s,
          loading: false,
          view: buildView(items, s.weekOffset),
        }));
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, loading: false, error: msg }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stub, ready]);
```

Add the same props interface + acceptance.

- [ ] **Step 4: Migrate history-tab.tsx**

Same pattern. The legacy code loops over statuses (`drafting | ready | posted | failed | rejected`); the @callable `queryDrafts` already drops the status arg (CMO.ts:432-453 — no status filter exists server-side). One call + client-side filter:

```typescript
  const { stub, ready } = useCmoStub({ userId, coreHost });

  useEffect(() => {
    let cancelled = false;
    void ready.then(async () => {
      if (cancelled) return;
      try {
        const all = (await stub.queryDrafts({ limit: 200 })) as Draft[];
        if (cancelled) return;
        // Filter out the "pending"/null buckets — those belong on the Today tab.
        const decided = all.filter((d) => d.decision !== null && d.decision !== undefined);
        setState({ loading: false, error: null, drafts: decided });
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ loading: false, error: msg, drafts: [] });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stub, ready]);
```

Add props interface + acceptance. Drop the per-status loop entirely.

- [ ] **Step 5: Check briefing-header.tsx**

Run: `cat /Users/yifeng/Documents/Code/shipflare/apps/web/app/\(app\)/briefing/_components/briefing-header.tsx | head -60`

If it does its own data fetch via `createCmoClient`, migrate the same way. If it just receives counts as props from a parent, no changes needed.

- [ ] **Step 6: If page.tsx renders multiple tabs, plumb props to all three**

If briefing/page.tsx has a tab shell rendering TodayTab + PlanTab + HistoryTab, update the render to:

```typescript
return (
  <BriefingShell>
    <TodayTab userId={session.user.id} coreHost={coreHost} />
    <PlanTab userId={session.user.id} coreHost={coreHost} />
    <HistoryTab userId={session.user.id} coreHost={coreHost} />
  </BriefingShell>
);
```

(extract `coreHost = resolveCoreHost(env.CORE_PUBLIC_URL)` once at the top of the component.)

- [ ] **Step 7: Type-check**

Run: `pnpm --filter @shipflare/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/\(app\)/briefing/
git commit -m "feat(web): /briefing tabs migrate to useCmoStub"
```

---

### Task 11: Migrate /growth/reddit-channels

**Why:** Last legacy CmoClient call site. Single `queryFounderContext` call.

**Files:**
- Modify: `apps/web/app/(app)/growth/reddit-channels/page.tsx`
- Modify: `apps/web/app/(app)/growth/reddit-channels/reddit-channels-content.tsx`

- [ ] **Step 1: Plumb userId + coreHost through the page**

Edit `apps/web/app/(app)/growth/reddit-channels/page.tsx`. Replace the file body with:

```typescript
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { RedditChannelsContent } from "./reddit-channels-content";

export const metadata: Metadata = { title: "Reddit communities" };
export const dynamic = "force-dynamic";

export default async function RedditChannelsPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[RedditChannelsPage] getSession failed", err);
  }
  if (!session?.user) return null;
  return (
    <RedditChannelsContent
      userId={session.user.id}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
```

- [ ] **Step 2: Migrate the client component**

Replace `createCmoClient` import with `useCmoStub`.

Add props:
```typescript
export interface RedditChannelsContentProps {
  userId: string;
  coreHost?: string;
}

export function RedditChannelsContent({ userId, coreHost }: RedditChannelsContentProps) {
```

Replace the `useEffect` that calls `createCmoClient()` + `queryFounderContext()`:

```typescript
  const { stub, ready } = useCmoStub({ userId, coreHost });

  useEffect(() => {
    let cancelled = false;
    void ready.then(async () => {
      if (cancelled) return;
      try {
        const ctx = await stub.queryFounderContext();
        if (cancelled) return;
        // KEEP all existing parsing of ctx.subreddits and state-setting here
      } catch (err) {
        // KEEP existing error handling here
      }
    });
    return () => {
      cancelled = true;
    };
  }, [stub, ready]);
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @shipflare/web exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/\(app\)/growth/reddit-channels/
git commit -m "feat(web): /growth/reddit-channels migrates to useCmoStub"
```

---

### Task 12: Delete dead client + token route

**Why:** Both `mcp-client.ts` and `/api/mcp-token` are now unused.

**Files:**
- Delete: `apps/web/src/lib/mcp-client.ts`
- Delete: `apps/web/app/api/mcp-token/route.ts`

- [ ] **Step 1: Sanity-grep for remaining imports**

```bash
grep -rn "from \"@/lib/mcp-client\"\|from '@/lib/mcp-client'\|@modelcontextprotocol/sdk" /Users/yifeng/Documents/Code/shipflare/apps/web/ 2>/dev/null
```
Expected: 0 matches. If any remain, migrate them BEFORE proceeding.

```bash
grep -rn "/api/mcp-token" /Users/yifeng/Documents/Code/shipflare/apps/web/ 2>/dev/null
```
Expected: 0 matches outside the route file itself.

- [ ] **Step 2: Delete the files**

```bash
rm /Users/yifeng/Documents/Code/shipflare/apps/web/src/lib/mcp-client.ts
rm /Users/yifeng/Documents/Code/shipflare/apps/web/app/api/mcp-token/route.ts
```

- [ ] **Step 3: Drop the browser-side SDK dep if unused**

```bash
grep -n "modelcontextprotocol" /Users/yifeng/Documents/Code/shipflare/apps/web/package.json
```

If it appears AND Step 1 showed 0 matches, edit `apps/web/package.json` and remove the `@modelcontextprotocol/sdk` line from `dependencies`. Then run `pnpm install`.

Skip this step if the SDK isn't listed in apps/web's package.json.

- [ ] **Step 4: Type-check both packages in parallel**

```bash
pnpm --filter @shipflare/web exec tsc --noEmit
pnpm --filter @shipflare/core exec tsc --noEmit
```
Both expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/ apps/web/app/api/mcp-token/ apps/web/package.json apps/web/pnpm-lock.yaml pnpm-lock.yaml
git commit -m "chore(web): delete dead MCP client + token route"
```

(Stage whichever lockfiles actually changed.)

---

### Task 13: Delete the apps/core MCP route + 503 stub

**Why:** With no browser caller, `handleMcpRequest` and its 503 stub are dead.

**Files:**
- Modify: `apps/core/src/index.ts`
- Modify: `apps/core/test/cmo-routing.test.ts`

- [ ] **Step 1: Delete the MCP_ROUTE regex (around line 187)**

Edit `apps/core/src/index.ts`. Delete the line:

```typescript
const MCP_ROUTE = /^\/agents\/([a-z-]+)\/([^/]+)\/mcp(?:\/|$)/;
```

- [ ] **Step 2: Delete the match block (around lines 515-519)**

Delete:

```typescript
  const mcpMatch = MCP_ROUTE.exec(url.pathname);
  if (mcpMatch) {
    const [, role, userId] = mcpMatch;
    return handleMcpRequest(request, env, role!, userId!);
  }
```

- [ ] **Step 3: Delete handleMcpRequest (the entire block around lines 707-764)**

From the banner comment about `/agents/<role>/<userId>/mcp` through the closing brace of `handleMcpRequest`.

- [ ] **Step 4: Update CMO_HTTP_ROUTE comment**

The existing comment at lines 215-217 mentions "Excludes /mcp[/...] (handled by MCP_ROUTE above)". Update to just mention `/internal/...` exclusion. Replace those two sentences with:

```typescript
 * Excludes `/internal/...` (INTERNAL_ROUTE, service-binding only) — that
 * path has stricter access controls.
```

- [ ] **Step 5: Drop the retired routing tests**

Run: `grep -n "describe.*mcp\|/agents/cmo.*mcp\|MCP transport\|/mcp routing" /Users/yifeng/Documents/Code/shipflare/apps/core/test/cmo-routing.test.ts`

Delete the entire `describe("Worker /agents/<role>/<userId>/mcp routing", ...)` block. The internal/* + WS routing tests stay.

- [ ] **Step 6: Type-check + run remaining routing tests**

```bash
pnpm --filter @shipflare/core exec tsc --noEmit
pnpm --filter @shipflare/core exec vitest run cmo-routing.test.ts
```
Both expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/index.ts apps/core/test/cmo-routing.test.ts
git commit -m "chore(core): delete retired /agents/cmo/<id>/mcp 503 stub"
```

---

### Task 14: Deploy to staging + real-browser smoke

**Why:** The global rule mandates real-browser Playwright testing on staging. We exercise all 13 callables across all 5 pages.

**Files:**
- None modified (deploy + smoke only)

- [ ] **Step 1: Deploy apps/core to staging**

```bash
pnpm --filter @shipflare/core exec wrangler deploy --env staging
```
Expected: deploy succeeds; verify with:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://mcp-staging.shipflare.ai/healthz
```
Expected: `200`.

- [ ] **Step 2: Deploy apps/web to staging**

```bash
pnpm --filter @shipflare/web exec wrangler deploy --env staging
```
Expected: deploy succeeds; URL is `https://app-staging.shipflare.ai`.

- [ ] **Step 3: Smoke /team in the local browser**

The staging session cookie is already present (user signed in as cdhyfpp@gmail.com via GitHub).

Open `https://app-staging.shipflare.ai/team`. Verify:
- Left rail shows 3 employee cards (CMO, Head of Growth, Social Media Manager); no "Failed to fetch"
- Conversation list renders (may be empty on a fresh tenant)
- Plan items + drafts render in the right panel
- DevTools Network tab: ONE WS to `wss://mcp-staging.shipflare.ai/agents/cmo/<userId>?token=...&tz=...`
- DevTools Console: no errors

Interactive:
- "New conversation" → new thread appears in the left rail
- Send a chat message → CMO responds (existing chat path)
- Click "Cancel" on any in-flight plan_item → status flips to cancelled

- [ ] **Step 4: Smoke /briefing**

Open `https://app-staging.shipflare.ai/briefing`. Verify the Today/Plan/History views render without "Failed to fetch".

- [ ] **Step 5: Smoke /growth/reddit-channels**

Open `https://app-staging.shipflare.ai/growth/reddit-channels`. Verify the subreddit list (or empty state) renders. Network tab: no separate request to `/api/mcp-token` — `queryFounderContext` rides the existing WS.

- [ ] **Step 6: Smoke teammate transcript drawer**

Back on `/team`, click a role card. Verify the drawer opens and renders `employee_log` rows.

- [ ] **Step 7: Verify the deleted routes are 404**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://mcp-staging.shipflare.ai/agents/cmo/x/mcp
curl -s -o /dev/null -w "%{http_code}\n" https://app-staging.shipflare.ai/api/mcp-token
```
Expected: `404` for both. Anything else means cleanup missed something.

- [ ] **Step 8: Append a smoke checkpoint to the RESUME doc**

Edit `docs/superpowers/plans/2026-05-18-phase-11-RESUME.md` and append at the bottom:

```markdown
## Addendum — 2026-05-19 (post Task #11)

Task #11 landed. All 7 right-panel call sites migrated to useCmoStub:

- /team — roster, conversations, plan_items, drafts, approve/reject/cancel
- /briefing/today — drafts + approve
- /briefing/plan — plan items bucketed by week
- /briefing/history — decided drafts
- /growth/reddit-channels — founder_context.subreddits
- /team transcript drawer — employee_log rows

Single WS per page (verified in DevTools). Old StreamableHTTP path
(/agents/cmo/<id>/mcp) and /api/mcp-token return 404. The cf-native-chat
PR can now ship without right-panel debt.
```

- [ ] **Step 9: Commit + push**

```bash
git add docs/superpowers/plans/2026-05-18-phase-11-RESUME.md
git commit -m "docs(plan): Phase 11 RESUME — Task #11 smoke checkpoint"
git push origin dev
```

---

## Self-review

Spec coverage check:
- §4.1 (10 wrapper @callable methods) → Tasks 2 + 3 ✓
- §4.2 (queryRoster registry-derived) → Task 5 ✓
- §4.3 (startNewConversation + listConversations) → Task 5 ✓
- §4.4 (conversations table) → Task 4 ✓
- §4.5 (auth — implicit via WS handshake) → not modified; covered by existing handleCmoWsRequest ✓
- §5.1 (delete mcp-client.ts + /api/mcp-token) → Task 12 ✓
- §5.2 (useCmoStub) → Task 7 ✓
- §5.3 (migrate 7 call sites) → Tasks 8, 9, 10, 11 ✓
- §6 (delete handleMcpRequest + MCP_ROUTE) → Task 13 ✓
- §7 (schema migration: no tag change) → Task 4 (idempotent CREATE) ✓
- §8.1 (unit tests) → Task 6 ✓
- §8.2 (integration / SELF.fetch round-trip) — NOT included as a separate task. Justification: per-method @callable behavior is verified in Task 6 via direct DO method invocation; the WS handshake auth is already covered by the existing cmo-routing tests (preserved through Task 13). A full SELF.fetch WS round-trip would need vitest-pool-workers WebSocket support that today is unreliable; the real-browser smoke in Task 14 covers the end-to-end path.
- §8.3 (real-browser smoke) → Task 14 ✓

Placeholder check: no TBD / TODO / "similar to" lines in the code blocks. Every step has actual code or a concrete grep/command.

Type consistency: stub method names match across `cmo-callable.ts` (Task 1), CMO's `@callable` methods (Tasks 2, 3, 5), and the `useCmoStub` wrappers (Task 7). PlanItemRow / DraftRow / MemoryRow / AgentTranscriptRow / ConversationRow / RosterRow are defined once in Task 1 and imported elsewhere.

Known caveat (called out inline in Task 10 Step 2): `TodayTab`'s local `Draft` interface includes fields like `body`, `why_it_works`, `confidence` that the @callable `queryDrafts` (approval_queue shape) doesn't return. The cards will render with these fields undefined. A follow-up plan can wire SMM's full draft shape through.
 */