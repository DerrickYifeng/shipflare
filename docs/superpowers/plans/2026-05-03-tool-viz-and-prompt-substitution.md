# Tool/Skill Call Visualization + System-Prompt Placeholder Substitution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two related defects observed in production:
1. The team-lead's tool calls (and any teammate's) are invisible in the founder UI — `agent-run.ts:handleStreamEvent` only persists `assistant_text_stop`, never `tool_start`/`tool_done`. The UI's `conversation-reducer.ts` and `activity-log.tsx` already render `tool_call` / `tool_result` rows; they just never arrive.
2. The lead's system prompt has unsubstituted `{productName}`, `{productState}`, `{currentPhase}`, `{channels}`, `{pathId}`, `{itemCount}`, `{statusBreakdown}`, `{TEAM_ROSTER}`, `{founderName}` placeholders. The lead reads them literally and hallucinates that "DB context isn't injected" instead of calling `query_strategic_path`.

**Architecture:** Two surgical changes. Task 1 extends the existing `handleStreamEvent` closure in `agent-run.ts` with two new handlers (`tool_start` → `tool_call` row; `tool_done` → `tool_result` row), reusing the lead-only SSE publish pattern already proven for `agent_text`. Task 2 introduces a small new helper `src/lib/team/system-prompt-context.ts` that queries product / strategic_path / plan_items / channels / user / team-roster, then substitutes placeholders into `def.systemPrompt` before `buildAgentConfigFromDefinition`. No engine touches; no schema migration.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Next.js worker context, BullMQ, Vitest (mocked DB), `pnpm tsc --noEmit` as the build gate.

---

## Pre-flight context (read once)

- Worker entry: `src/workers/processors/agent-run.ts:485-610` (the `handleStreamEvent` closure) and `:660-690` (the `runAgent` invocation).
- `StreamEvent` union: `src/core/types.ts:133-205` (`tool_start`, `tool_done`, `assistant_text_stop` shapes).
- `team_messages` schema: `src/lib/db/schema/team.ts:215-260` — `type` already enumerates `tool_call` / `tool_result`; `metadata` jsonb absorbs `{ tool_use_id, tool_name, tool_input, tool_output, ... }`.
- UI consumers (no change needed): `src/app/(app)/team/_components/conversation-reducer.ts:374-650` and `src/app/(app)/team/_components/activity-log.tsx:483-...` already react to `type === 'tool_call' | 'tool_result'`.
- Lead SSE channel publisher: see `src/workers/processors/agent-run.ts:565-600` for the `agent_text` precedent — Task 1 mirrors that envelope.
- AGENT.md placeholder source: `src/tools/AgentTool/agents/coordinator/AGENT.md:28-57` lists exactly which tokens need substituting.
- Existing TEAM_ROSTER builder: `src/tools/AgentTool/prompt.ts:103-145` (`formatAgentLine`) — already used by `buildTaskDescription`; reuse it.
- Run-time wiring point: `agent-run.ts:669` calls `buildAgentConfigFromDefinition(def)`. Task 2 inserts a `def = { ...def, systemPrompt: substitutePlaceholders(...) }` rebind on the line above.
- Build gate: `pnpm tsc --noEmit --pretty false` must exit 0. Vitest uses `isolatedModules` so it does NOT type-check; a green test run is not sufficient.

---

## Task 1: Persist `tool_call` + `tool_result` rows + lead-path SSE publish

**Files:**
- Modify: `src/workers/processors/agent-run.ts:485-610` (extend `handleStreamEvent`)
- Test (modify or extend): `src/workers/processors/__tests__/agent-run.test.ts`

### Task 1 spec

When `runAgent` emits a `tool_start` event, insert one `team_messages` row:
- `id`: `crypto.randomUUID()`
- `teamId`: `row.teamId`
- `conversationId`: `isLead ? leadConversationId : null` (mirrors `agent_text` row)
- `type`: `'tool_call'`
- `messageType`: `'message'`
- `fromMemberId`: `row.memberId`
- `fromAgentId`: `agentId`
- `runId`: `leadRequestId` (lead path) — keeps the per-run grouping in the UI
- `content`: the tool name (so the row is human-readable without parsing metadata; e.g. `"query_strategic_path"`)
- `metadata`: `{ tool_use_id: event.toolUseId, tool_name: event.toolName, tool_input: event.input }`
- `deliveredAt`: `new Date()`
- `createdAt`: same `new Date()`

When `runAgent` emits a `tool_done` event (and it's NOT the Sleep early-exit case already handled), insert one `team_messages` row:
- Same structural fields as above, with:
  - `type`: `'tool_result'`
  - `content`: truncated `event.result.content` (cap at 4 000 chars; append `…` when truncated) so we don't blow up the team_messages row size for tools that return huge JSON
  - `metadata`: `{ tool_use_id: event.toolUseId, tool_name: event.toolName, tool_output: event.result.content, is_error: !!event.result.is_error, duration_ms: event.durationMs }` (full content lives here for the UI's "expand" affordance)

**Lead path additionally publishes both rows to the SSE channel** (`teamMessagesChannel(row.teamId)`), with the same envelope shape used by `agent_text` — `{ messageId, conversationId, runId, teamId, from, fromAgentId, type, content, metadata, createdAt }`. Teammates skip the publish (their tool activity reaches the lead only as `<task-notification>` summaries; the live SSE channel is for the founder-visible lead conversation).

**Skip rules** (do not insert / publish):
- `event.toolName === 'Sleep'` — Sleep is signaling, not user-visible tool work; the existing handler already detects it and aborts.
- `event.toolName === 'SyntheticOutput'` — synthesized terminal-only tool; already covered by the `assistant_text_stop` row.

If the DB insert throws, log and continue (mirrors the existing `agent_text` failure handling — the stream must not be torn down by a persistence hiccup).

### Task 1 steps

- [ ] **Step 1: Write the failing test** (extend existing test file)

  Add three tests to `src/workers/processors/__tests__/agent-run.test.ts`:
  
  1. `'persists tool_call row when runAgent emits tool_start'` — drive the worker with a stub `runAgent` that fires one `tool_start` event, then assert `db.insert(teamMessages).values` was called with `type: 'tool_call'`, `content: 'query_strategic_path'`, and `metadata.tool_use_id === 'toolu_test_1'`.
  2. `'persists tool_result row when runAgent emits tool_done'` — same, with `tool_done` event; assert `type: 'tool_result'`, `metadata.is_error === false`, `metadata.duration_ms === 42`, and `content` is the truncated form when input > 4 000 chars.
  3. `'lead path publishes tool_call to SSE channel'` — assert the pub-sub publisher's `publish` was called with the team's channel name and an envelope whose `type === 'tool_call'`. Use the existing pub-sub mock pattern in the file.

  ```ts
  // Pseudocode shape the implementer fills in to match the file's existing helpers:
  it('persists tool_call row when runAgent emits tool_start', async () => {
    runAgentMock.mockImplementationOnce(async (_cfg, _prompt, _ctx, _schema, _onProg, _prebuilt, _onIdle, onEvent) => {
      onEvent?.({
        type: 'tool_start',
        toolName: 'query_strategic_path',
        toolUseId: 'toolu_test_1',
        input: { reason: 'test' },
      });
      return makeFakeRunResult();
    });
    await processAgentRun({ data: { agentId: 'a-1' } } as any);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool_call',
        content: 'query_strategic_path',
        metadata: expect.objectContaining({
          tool_use_id: 'toolu_test_1',
          tool_name: 'query_strategic_path',
          tool_input: { reason: 'test' },
        }),
      }),
    );
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: the three new tests fail (no `tool_call` / `tool_result` row inserted; no SSE publish).

- [ ] **Step 3: Implement the handler in `handleStreamEvent`**

  Inside `agent-run.ts:handleStreamEvent`, **after** the existing `assistant_text_stop` block and **before** the existing Sleep `tool_done` early-exit detector, add:

  ```ts
  // Persist tool_call rows (tool_start) and tool_result rows (tool_done)
  // so the founder UI can render the lead's tool usage. Skip Sleep
  // (signaling-only) and SyntheticOutput (terminal write covered by
  // assistant_text_stop) so we don't double-paint those.
  if (event.type === 'tool_start' || event.type === 'tool_done') {
    if (event.toolName === 'Sleep' || event.toolName === 'SyntheticOutput') {
      // For Sleep, the existing tool_done handler below still needs to fire.
      // Fall through after the persist branch returns nothing.
    } else {
      const insertedId = crypto.randomUUID();
      const createdAt = new Date();
      const isCall = event.type === 'tool_start';
      const TRUNC_LIMIT = 4000;
      const rawContent = isCall
        ? event.toolName
        : event.result.content;
      const truncatedContent =
        !isCall && rawContent.length > TRUNC_LIMIT
          ? `${rawContent.slice(0, TRUNC_LIMIT)}…`
          : rawContent;
      const metadata = isCall
        ? {
            tool_use_id: event.toolUseId,
            tool_name: event.toolName,
            tool_input: event.input,
          }
        : {
            tool_use_id: event.toolUseId,
            tool_name: event.toolName,
            tool_output: event.result.content,
            is_error: !!event.result.is_error,
            duration_ms: event.durationMs,
          };
      try {
        await db.insert(teamMessages).values({
          id: insertedId,
          teamId: row.teamId,
          conversationId: isLead ? leadConversationId : null,
          type: isCall ? 'tool_call' : 'tool_result',
          messageType: 'message',
          fromMemberId: row.memberId,
          fromAgentId: agentId,
          runId: leadRequestId,
          content: truncatedContent,
          metadata,
          deliveredAt: createdAt,
          createdAt,
        });
      } catch (err) {
        log.warn(
          `agent-run ${agentId}: failed to persist ${isCall ? 'tool_call' : 'tool_result'}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // fall through; persistence failure must not abort the stream.
      }
      if (def.role === 'lead') {
        try {
          const pub = getPubSubPublisher();
          await pub.publish(
            teamMessagesChannel(row.teamId),
            JSON.stringify({
              messageId: insertedId,
              conversationId: leadConversationId,
              runId: leadRequestId,
              teamId: row.teamId,
              from: row.memberId,
              fromAgentId: agentId,
              type: isCall ? 'tool_call' : 'tool_result',
              content: truncatedContent,
              metadata,
              createdAt: createdAt.toISOString(),
            }),
          );
        } catch (err) {
          log.warn(
            `agent-run ${agentId}: SSE publish failed for ${isCall ? 'tool_call' : 'tool_result'}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    // Don't return — let Sleep tool_done detection below still run for the Sleep case.
  }
  ```

  Important: the function MUST still fall through to the existing Sleep early-exit block when `event.type === 'tool_done' && event.toolName === 'Sleep'`. The added block returns nothing — control continues to the existing `if (event.type !== 'tool_done') return;` guard.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: PASS — all three new tests + the prior Sleep / `assistant_text_stop` tests still green.

- [ ] **Step 5: Type-check the build gate**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit code 0. (Build gate is `tsc`, not vitest — vitest's isolatedModules skips type-checking.)

- [ ] **Step 6: Commit**

  ```bash
  git add src/workers/processors/agent-run.ts src/workers/processors/__tests__/agent-run.test.ts
  git commit -m "$(cat <<'EOF'
  feat(agent-run): persist tool_call + tool_result rows for UI visibility

  agent-run.ts:handleStreamEvent only persisted assistant_text_stop, so the
  team-lead's (and any teammate's) tool usage was invisible in the founder
  UI — even though conversation-reducer.ts and activity-log.tsx already
  render tool_call/tool_result rows. Add tool_start → tool_call and
  tool_done → tool_result inserts (Sleep + SyntheticOutput excluded), and
  publish on the lead's SSE channel so the UI paints live.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: System-prompt placeholder substitution helper + agent-run wiring

**Files:**
- Create: `src/lib/team/system-prompt-context.ts`
- Create: `src/lib/team/__tests__/system-prompt-context.test.ts`
- Modify: `src/workers/processors/agent-run.ts:660-690` (insert substitution before `buildAgentConfigFromDefinition`)
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md:28-35` (delete the obsolete `TODO(phase-d)` comment block — substitution now ships)

### Task 2 spec

Introduce `src/lib/team/system-prompt-context.ts` with two exports:

```ts
export interface SystemPromptContext {
  productName: string;
  productDescription: string;
  productState: string;          // 'mvp' | 'launching' | 'launched' | 'unknown'
  currentPhase: string;          // strategic_path.phase or 'unknown'
  channels: string;              // 'x, reddit' or 'none yet'
  strategicPathId: string;       // the active path's id, or 'none yet'
  itemCount: number;             // count of plan_items for the team this UTC week
  statusBreakdown: string;       // 'planned: 5, drafted: 2, scheduled: 1' (omit 0s; '' when itemCount=0)
  founderName: string;           // user.name ?? user.email's local part ?? 'founder'
  teamRoster: string;            // formatTeamRoster(allTeamAgentDefinitions)
}

export async function loadSystemPromptContext(args: {
  teamId: string;
  db: typeof import('@/lib/db').db;
}): Promise<SystemPromptContext>;

export function substitutePlaceholders(
  template: string,
  ctx: SystemPromptContext,
): string;
```

Substitution rules (NEVER throw on missing placeholder — leave unmatched braces in place; the AGENT.md author owns the template):
- `{productName}` → `ctx.productName`
- `{productDescription}` → `ctx.productDescription`
- `{productState}` → `ctx.productState`
- `{currentPhase}` → `ctx.currentPhase`
- `{channels}` → `ctx.channels`
- `{pathId | "none yet"}` → `ctx.strategicPathId` (note the literal `| "none yet"` syntax in AGENT.md; treat the whole token as one placeholder)
- `{pathId}` → `ctx.strategicPathId` (also support the bare form for future templates)
- `{itemCount}` → `String(ctx.itemCount)`
- `{statusBreakdown}` → `ctx.statusBreakdown`
- `{TEAM_ROSTER}` → `ctx.teamRoster`
- `{founderName}` → `ctx.founderName`

`loadSystemPromptContext`:
1. Look up `team` by `teamId`. If missing, throw `Error('team not found: <id>')`.
2. Look up `product` by `team.productId` (LEFT JOIN — productId may be null for legacy teams). If missing, default `productName='your product'`, `productDescription='(product not configured)'`, `productState='unknown'`.
3. Look up the active `strategic_path` for the team: `WHERE teamId = $1 ORDER BY createdAt DESC LIMIT 1`. If none, `currentPhase='unknown'`, `strategicPathId='none yet'`.
4. Look up `channels` for the team's userId: `SELECT DISTINCT platform FROM channels WHERE userId = $1`. Join with comma + space. If none, `'none yet'`.
5. Plan items for the current UTC week (Mon 00:00 → next Mon 00:00 UTC): `SELECT status, count(*) FROM plan_items WHERE teamId = $1 AND scheduledAt >= weekStart AND scheduledAt < weekEnd GROUP BY status`. `itemCount` = total. `statusBreakdown` = comma-separated `'<status>: <n>'` for each row, sorted by count descending; empty string if `itemCount === 0`.
6. Founder name: `SELECT name, email FROM users WHERE id = team.userId`. `name ?? email.split('@')[0] ?? 'founder'`.
7. Team roster: load all `AgentDefinition`s the team can spawn — reuse the existing pattern. Look up `team_members` by `teamId`, map each `agentType` through the agent registry's `loadAgent(agentType)`, and pass the loaded defs to a new helper `formatTeamRoster(defs: AgentDefinition[]): string` (place this helper inside `system-prompt-context.ts` — one-line per agent using existing `formatAgentLine` from `src/tools/AgentTool/prompt.ts`). If the registry can't load an agent (legacy member), skip it with a `log.warn`.

`substitutePlaceholders` is a small synchronous string `.replace()` chain. Order matters because `{pathId | "none yet"}` must match before `{pathId}` to avoid leaving an orphaned ` | "none yet"}` tail.

In `agent-run.ts:669`, replace:
```ts
const config = buildAgentConfigFromDefinition(def);
```
with:
```ts
const promptCtx = await loadSystemPromptContext({ teamId: row.teamId, db });
const renderedDef: AgentDefinition = {
  ...def,
  systemPrompt: substitutePlaceholders(def.systemPrompt, promptCtx),
};
const config = buildAgentConfigFromDefinition(renderedDef);
```
Add the imports at the top of the file:
```ts
import {
  loadSystemPromptContext,
  substitutePlaceholders,
} from '@/lib/team/system-prompt-context';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
```

Finally, in `src/tools/AgentTool/agents/coordinator/AGENT.md`, delete lines 28-35 (the `<!-- TODO(phase-d): ... -->` HTML comment) — the substitution now ships, so the warning is stale.

### Task 2 steps

- [ ] **Step 1: Write the failing test**

  Create `src/lib/team/__tests__/system-prompt-context.test.ts` with these tests:

  1. `'substitutePlaceholders replaces every documented token'` — synchronous, no DB; pass a template containing all 10 placeholder tokens and assert each is replaced.
  2. `'substitutePlaceholders leaves unknown braces untouched'` — input `'hello {unknown}'` → output `'hello {unknown}'`.
  3. `'substitutePlaceholders matches {pathId | "none yet"} before {pathId}'` — input contains both forms; both are correctly replaced with the same `strategicPathId` value (no `| "none yet"` tail left behind).
  4. `'loadSystemPromptContext returns sane defaults when no product / path / items / channels exist'` — drizzle-mocked DB returns empty results; assert `productName='your product'`, `productState='unknown'`, `currentPhase='unknown'`, `strategicPathId='none yet'`, `channels='none yet'`, `itemCount=0`, `statusBreakdown=''`.
  5. `'loadSystemPromptContext composes the happy path correctly'` — drizzle-mocked DB returns realistic rows; assert each field. Use `mockDb` patterns already in the repo (look at sibling tests in `src/lib/team/__tests__/` for the established style).
  6. `'loadSystemPromptContext throws when team is not found'`.

  ```ts
  // Sketch — implementer fills in to match the file's existing mock shape:
  it('substitutePlaceholders replaces every documented token', () => {
    const tpl =
      'P:{productName} D:{productDescription} S:{productState} F:{currentPhase} ' +
      'C:{channels} A:{pathId | "none yet"} I:{itemCount} B:{statusBreakdown} ' +
      'T:{TEAM_ROSTER} N:{founderName}';
    const out = substitutePlaceholders(tpl, {
      productName: 'Acme',
      productDescription: 'a thing',
      productState: 'launched',
      currentPhase: 'growth',
      channels: 'x, reddit',
      strategicPathId: 'sp_123',
      itemCount: 5,
      statusBreakdown: 'planned: 3, drafted: 2',
      founderName: 'Alex',
      teamRoster: '- coordinator: Chief of Staff',
    });
    expect(out).toBe(
      'P:Acme D:a thing S:launched F:growth C:x, reddit A:sp_123 I:5 B:planned: 3, drafted: 2 T:- coordinator: Chief of Staff N:Alex',
    );
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `pnpm vitest run src/lib/team/__tests__/system-prompt-context.test.ts`
  Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement `system-prompt-context.ts`**

  Create `src/lib/team/system-prompt-context.ts` per the spec above. Use the established repo patterns:
  - Drizzle imports: `import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';`
  - Schema imports: `import { teams, teamMembers, planItems, channels as channelsTable, strategicPaths } from '@/lib/db/schema';` plus `import { products } from '@/lib/db/schema/products';` and `import { users } from '@/lib/db/schema/users';`
  - Logger: `import { createLogger } from '@/lib/logger';`
  - For the team roster, reuse the existing agent registry / loader at `@/tools/AgentTool/loader` (look at `src/tools/AgentTool/prompt.ts:118-145` for the established pattern and copy the iteration shape).
  - UTC week boundaries: Monday 00:00:00 UTC of the current week → next Monday 00:00:00 UTC. Compute via `new Date()` arithmetic; do NOT pull in a date library.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `pnpm vitest run src/lib/team/__tests__/system-prompt-context.test.ts`
  Expected: PASS — all six tests green.

- [ ] **Step 5: Wire into `agent-run.ts`**

  In `src/workers/processors/agent-run.ts`:
  1. Add imports at the top (alongside existing `@/lib/team/...` imports).
  2. Replace line 669 (`const config = buildAgentConfigFromDefinition(def);`) with the three-line substitution block from the spec.

  Then add an integration-style test to `src/workers/processors/__tests__/agent-run.test.ts`:

  ```ts
  it('substitutes system-prompt placeholders before invoking runAgent', async () => {
    // Mock loadSystemPromptContext to return a known ctx; load a fixture
    // def whose systemPrompt contains '{productName}'; assert that the
    // systemPrompt passed to runAgent contains the substituted value, not
    // the literal '{productName}'.
  });
  ```

- [ ] **Step 6: Run wiring test**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: PASS — all prior tests + the new substitution test green.

- [ ] **Step 7: Delete the stale TODO from coordinator AGENT.md**

  Remove lines 28-35 (the `<!-- TODO(phase-d): ... -->` block) from `src/tools/AgentTool/agents/coordinator/AGENT.md`. Leave the rest of the prompt unchanged.

- [ ] **Step 8: Type-check the build gate**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit code 0.

- [ ] **Step 9: Commit**

  ```bash
  git add src/lib/team/system-prompt-context.ts \
          src/lib/team/__tests__/system-prompt-context.test.ts \
          src/workers/processors/agent-run.ts \
          src/workers/processors/__tests__/agent-run.test.ts \
          src/tools/AgentTool/agents/coordinator/AGENT.md
  git commit -m "$(cat <<'EOF'
  feat(team-lead): substitute system-prompt placeholders at run time

  The coordinator's AGENT.md ships with {productName}, {productState},
  {currentPhase}, {channels}, {pathId | "none yet"}, {itemCount},
  {statusBreakdown}, {TEAM_ROSTER}, and {founderName} placeholders. Until
  now the lead saw them literally and improvised "DB context not injected"
  excuses instead of calling query_strategic_path. Add
  loadSystemPromptContext + substitutePlaceholders, wire into agent-run
  before buildAgentConfigFromDefinition, and drop the stale TODO comment.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review checklist (controller runs after writing the plan)

- [x] **Spec coverage** — both reported defects (viz gap + placeholder gap) each have a dedicated task with concrete steps.
- [x] **Placeholder scan** — every "TBD"/"TODO" pattern has an owner; no "fill in details" steps.
- [x] **Type consistency** — `SystemPromptContext` interface declared once and used identically by `loadSystemPromptContext` return + `substitutePlaceholders` input.
- [x] **Build gate** — every implementing task ends with `pnpm tsc --noEmit --pretty false` (per the saved feedback memory: vitest's `isolatedModules` is not a substitute).
- [x] **Skip rules in Task 1** — Sleep / SyntheticOutput exclusions are documented AND the implementation falls through so the existing Sleep early-exit detector still fires.
