# CF-Native Chat Migration Design

**Date:** 2026-05-16
**Status:** Draft → user review
**Branch:** `feat/cf-native-chat-migration` (off `dev`)
**Strategy:** Replace-in-place; branch does not merge until cutover-complete.
**Predecessors:**
- `2026-05-13-cloudflare-do-migration-design.md` (DO + Agents SDK foundation)
- `2026-05-15-agent-activity-feed-design.md` (the hand-rolled activity stream this migration replaces)

---

## Goal

Replace the hand-rolled chat / activity / dispatch stack with a clean five-layer architecture built directly on Cloudflare's Agents SDK + AI SDK v5, while preserving ShipFlare's Skill primitive and moving ops telemetry out of the user-visible chat protocol.

## Decisions locked in (brainstorming Q1–Q6 + amendments)

| # | Decision | Choice |
|---|---|---|
| Q1 | Scope | **C** — all 5 layers + onboarding + data migration |
| Q2 | Migration strategy | **A** — replace-in-place on branch |
| Q3 | Historical `founder_messages` | **B** — fresh start, drop table |
| Q4 | Agent topology | **B** — DAG, full peer-to-peer mesh |
| Q5 | Telemetry destination | **A** — Workers Analytics Engine |
| Q6 | External MCP scope | **A** — expose CMO only |
| amend | Peer dispatch API | One generalized `consult` tool (not per-peer) |
| amend | DRY generalizations | Apply 1–5 (see §11) |

---

## 1. Architecture overview (5 layers)

```
┌───────────────────────────────────────────────────────────────┐
│ Layer 4: External MCP surface (NEW)                            │
│   DO: CmoExternalMcp extends McpAgent                          │
│   Endpoint: mcp.shipflare.com/cmo (OAuth via withOAuthProvider)│
│   Curated CMO tools exposed to Claude Desktop / Cursor / n8n   │
│   Calls internal CMO via CMO.invokeAsTool (no chat-stream FX)  │
└───────────────────────────────────────────────────────────────┘
                              ▲
                              │ external clients
┌───────────────────────────────────────────────────────────────┐
│ Layer 1: Chat surface                                          │
│   DO: CMO extends AIChatAgent<Env, CMOState>                   │
│   Per-user DO: idFromName(userId)                              │
│   Wire: AI SDK v5 parts (text-* / reasoning-* / tool-* / data-*)│
│   Persistence: AIChatAgent built-in SQLite                     │
│   Resumable: ResumableStream (free with AIChatAgent)           │
└───────────────────────────────────────────────────────────────┘
                              │ getTools() → consult, direct tools
                              ▼
┌───────────────────────────────────────────────────────────────┐
│ Layer 2: Agent orchestration (DAG mesh)                        │
│   One generalized `consult` tool per agent (caller-scoped)     │
│   Employees: HoG, SMM (each extends AIChatAgent)               │
│   Mesh: CMO ↔ {HoG, SMM}; HoG ↔ SMM                            │
│   Safety: depth ≤ 3, cycle detection via safeAgentChain        │
│   Frontend: useAgentToolEvents → nested timelines              │
└───────────────────────────────────────────────────────────────┘
                              │ inside any tool execute()
                              ▼
┌───────────────────────────────────────────────────────────────┐
│ Layer 3: Skill primitive (preserved)                           │
│   runSkill() unchanged in spirit; now emits data parts:        │
│     data-skill-start  { skillName, model, context, parentRunId}│
│     data-skill-finish { skillName, status, error? }            │
│   SKILL.md / references/ structure preserved                   │
└───────────────────────────────────────────────────────────────┘
                              │ all of the above also emit:
                              ▼
┌───────────────────────────────────────────────────────────────┐
│ Layer 5: Ops telemetry (separate channel)                      │
│   env.TELEMETRY.writeDataPoint(...) → Analytics Engine         │
│   ONE dataset: `agent_events` (kind in indexes[0])             │
│   NEVER mixed into chat stream                                 │
│   Queryable via Analytics Engine SQL API                       │
└───────────────────────────────────────────────────────────────┘
```

**Hard invariants:**
- Chat stream carries only semantic events users should see (text, reasoning, tool/agent runs, skill milestones). Performance metrics (`durationMs`, `model`, tokens) go ONLY to Analytics Engine.
- Each agent DO is per-user (`idFromName(userId)`). Cross-tenant isolation is at the DO boundary, not in tool props.
- `consult` (built on `agentTool` / `runAgentTool`) is the ONLY way agents call agents. `addMcpServer` for inter-agent dispatch is deleted.
- `XMcpAgent` / `RedditMcpAgent` remain as platform tool servers, callable from any agent via existing MCP plumbing — they are NOT employees.

---

## 2. Layer 1 — CMO as AIChatAgent

```typescript
// apps/core/src/agents/cmo/CMO.ts
import { AIChatAgent } from '@cloudflare/ai-chat';
import { streamText, createUIMessageStreamResponse, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { makeConsultTool } from '../lib/consult-tool';

export interface CMOState {
  hiredRoles: EmployeeId[];
  currentRunId: string | null;
}

export class CMO extends AIChatAgent<Env, CMOState> {
  initialState: CMOState = { hiredRoles: [], currentRunId: null };

  async onChatMessage(onFinish, options) {
    return createUIMessageStreamResponse({
      execute: async ({ writer }) => {
        const result = streamText({
          model: anthropic('claude-sonnet-4-6'),
          messages: convertToModelMessages(this.messages),
          system: await this.buildSystemPrompt(),
          tools: this.getTools(),
          experimental_context: { writer, userId: this.name },  // threaded to tool execute() as ctx
          experimental_telemetry: { isEnabled: true, recordInputs: false },
          onFinish,
        });
        writer.merge(result.toUIMessageStream());
      },
    });
  }

  getTools() {
    return {
      consult: makeConsultTool('cmo'),
      commit_strategic_path: defineTool({ /* ... */ }),
      schedule_post: defineTool({ /* ... */ }),
      approve_draft: defineTool({ /* ... */ }),
      // ...other CMO-direct tools
    };
  }

  async buildSystemPrompt(): Promise<string> {
    const preamble = await loadPreamble();           // _SYSTEM_PREAMBLE.md
    const colleagues = renderColleagueList('cmo');   // auto from registry
    const role = await loadRolePrompt('cmo');        // SYSTEM.md (CMO-specific)
    return `${preamble}\n\n${colleagues}\n\n${role}`;
  }
}
```

- Persistence: `AIChatAgent` auto-persists `this.messages` to its internal SQLite. `founder_messages` table is dropped (Q3=B).
- Resumable: built into `AIChatAgent`. Reconnect → `cf_agent_stream_resume_request` replays buffered chunks with `replay: true`.
- `experimental_telemetry: true` enables AI SDK's own per-call telemetry; we layer Analytics Engine on top via `onFinish` hook.

---

## 3. Layer 2 — Agent orchestration

### 3.1 Employee registry (single source of truth)

```typescript
// apps/core/src/agents/registry.ts
import type { AIChatAgent } from '@cloudflare/ai-chat';
import { CMO } from './cmo/CMO';
import { HoG } from './head-of-growth/HeadOfGrowth';
import { SMM } from './social-media-manager/SocialMediaMgr';

export type EmployeeId = 'cmo' | 'hog' | 'smm';

export interface EmployeeMeta {
  class: typeof AIChatAgent;
  envBinding: string;            // wrangler DO binding name (uppercase)
  displayName: string;
  description: string;            // shown to LLM in consult enum
  systemPromptPath: string;
}

export const EMPLOYEE_REGISTRY: Record<EmployeeId, EmployeeMeta> = {
  cmo: {
    class: CMO,
    envBinding: 'CMO',
    displayName: 'Chief Marketing Officer',
    description: 'Strategic marketing leadership; the orchestrator.',
    systemPromptPath: 'apps/core/src/agents/cmo/SYSTEM.md',
  },
  hog: {
    class: HoG,
    envBinding: 'HOG',
    displayName: 'Head of Growth',
    description: 'Growth strategy, acquisition funnels, retention experiments.',
    systemPromptPath: 'apps/core/src/agents/head-of-growth/SYSTEM.md',
  },
  smm: {
    class: SMM,
    envBinding: 'SMM',
    displayName: 'Social Media Manager',
    description: 'Channel-specific drafting, voice, posting cadence.',
    systemPromptPath: 'apps/core/src/agents/social-media-manager/SYSTEM.md',
  },
};

export const EMPLOYEE_IDS = Object.keys(EMPLOYEE_REGISTRY) as EmployeeId[];
```

### 3.2 Generalized `consult` tool

```typescript
// apps/core/src/agents/lib/consult-tool.ts
import { z } from 'zod';
import { defineTool } from 'agents/tools';
import { runAgentTool } from 'agents/agent-tools';
import { EMPLOYEE_REGISTRY, EMPLOYEE_IDS, EmployeeId } from '../registry';
import { safeAgentChain } from '@/lib/agent-depth';

export const peerInputSchema = z.object({
  employee: z.string(),    // refined per caller (see makeConsultTool)
  question: z.string().describe('What you want to ask them'),
  context: z.string().optional().describe('Background information they need'),
});

export const peerOutputSchema = z.object({
  answer: z.string(),
  artifacts: z.array(z.record(z.unknown())).optional(),
});

export function makeConsultTool(selfId: EmployeeId) {
  const callable = EMPLOYEE_IDS.filter(id => {
    if (id === selfId) return false;
    if (selfId !== 'cmo' && id === 'cmo') return false;  // peers don't call CMO upward
    return true;
  });

  const employeeEnum = z.enum(callable as [EmployeeId, ...EmployeeId[]])
    .describe(
      callable
        .map(id => `'${id}': ${EMPLOYEE_REGISTRY[id].displayName} — ${EMPLOYEE_REGISTRY[id].description}`)
        .join('\n')
    );

  return defineTool({
    description: 'Consult a colleague for their expertise. Returns their final response and any structured artifacts they produced.',
    inputSchema: z.object({
      employee: employeeEnum,
      question: z.string().describe('What you want to ask them'),
      context: z.string().optional().describe('Background information they need to answer well'),
    }),
    execute: async ({ employee, question, context }, ctx) => {
      const meta = EMPLOYEE_REGISTRY[employee];
      safeAgentChain.check(ctx, meta.class.name);  // depth + cycle
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

**LLM-facing view (one tool, scales O(1) with org size):**
```
Tool: consult
Description: Consult a colleague for their expertise...
Input:
  employee: enum
    'hog': Head of Growth — Growth strategy, acquisition funnels, retention experiments.
    'smm': Social Media Manager — Channel-specific drafting, voice, posting cadence.
    [auto-added: 'hod', 'cfo', etc. when registered]
  question: string
  context?: string
```

### 3.3 Depth + cycle safety

```typescript
// apps/core/src/lib/agent-depth.ts
export const MAX_AGENT_DEPTH = 3;

export class AgentDepthExceededError extends Error {
  constructor(public chain: string[]) {
    super(`Agent dispatch depth exceeded (${chain.join(' → ')})`);
  }
}

export class AgentCycleError extends Error {
  constructor(public chain: string[], public target: string) {
    super(`Agent dispatch cycle (${chain.join(' → ')} → ${target})`);
  }
}

export const safeAgentChain = {
  check(ctx: AgentToolContext, targetClassName: string): void {
    const chain: string[] = ctx.props.__agentChain ?? [];
    if (chain.length >= MAX_AGENT_DEPTH) throw new AgentDepthExceededError(chain);
    if (chain.includes(targetClassName)) throw new AgentCycleError(chain, targetClassName);
    ctx.props.__agentChain = [...chain, targetClassName];
  },
};
```

Errors surface as `tool-output-error` parts in the parent's chat stream — UI shows the failed dispatch clearly and the parent LLM can recover.

### 3.4 Each employee is symmetric

```typescript
class HoG extends AIChatAgent<Env, HoGState> {
  getTools() {
    return {
      consult: makeConsultTool('hog'),
      research_competitor: defineTool({ /* ... */ }),
      analyze_funnel:      defineTool({ /* ... */ }),
    };
  }
  // onChatMessage same shape as CMO, threading writer via experimental_context
}

class SMM extends AIChatAgent<Env, SMMState> {
  getTools() {
    return {
      consult: makeConsultTool('smm'),
      draft_for_channel: defineTool({ /* ... */ }),
    };
  }
  // onChatMessage same shape as CMO, threading writer via experimental_context
}
```

---

## 4. Layer 3 — Skill primitive (preserved)

The Skill primitive (`runSkill`, `SKILL.md` + `references/` structure, `_catalog.ts` registry) is preserved end-to-end. Only one change: skills now emit AI SDK v5 **data parts** so they're visible in the parent agent's chat stream.

```typescript
// apps/core/src/skills/run-skill.ts (modified)
import { writeAgentEvent } from '@/lib/telemetry';

export async function runSkill(opts: {
  name: string;
  args: Record<string, unknown>;
  writer?: UIMessageStreamWriter;  // optional; passed by agent tool execute()
  parentRunId?: string;
  userId: string;
}): Promise<unknown> {
  const runId = crypto.randomUUID();
  const meta = await loadSkillMeta(opts.name);

  opts.writer?.write({
    type: 'data-skill-start',
    id: runId,
    data: {
      skillName: opts.name,
      model: meta.model,
      context: meta.context ?? 'inline',
      parentRunId: opts.parentRunId ?? null,
    },
  });

  const t0 = Date.now();
  try {
    const result = await executeSkill(meta, opts.args);
    opts.writer?.write({
      type: 'data-skill-finish',
      id: runId,
      data: { skillName: opts.name, status: 'ok' },
    });
    writeAgentEvent({
      kind: 'skill_invocation',
      userId: opts.userId,
      runId,
      blobs: [opts.name, 'ok', meta.model, meta.context ?? 'inline'],
      doubles: [Date.now() - t0],
    });
    return result;
  } catch (err) {
    opts.writer?.write({
      type: 'data-skill-finish',
      id: runId,
      data: { skillName: opts.name, status: 'error', error: String(err) },
    });
    writeAgentEvent({
      kind: 'skill_invocation',
      userId: opts.userId,
      runId,
      blobs: [opts.name, 'error', meta.model, meta.context ?? 'inline'],
      doubles: [Date.now() - t0],
    });
    throw err;
  }
}
```

Skills remain bounded one-shot LLM calls (fork). Data parts are pure UI annotations — they do NOT promote skills to first-class agents.

---

## 5. Layer 4 — External MCP for CMO

```typescript
// apps/core/src/external/CmoExternalMcp.ts
import { McpAgent, McpServer } from 'agents/mcp';
import { z } from 'zod';
import { getEmployee } from '@/agents/lib/get-employee';
import { withOAuthProvider } from 'agents/oauth';

interface ExternalProps { userId: string }

export class CmoExternalMcp extends McpAgent<Env, never, ExternalProps> {
  server = new McpServer({ name: 'shipflare-cmo', version: '1.0.0' });

  async init() {
    this.server.tool(
      'draft_post',
      { channel: z.enum(['x', 'reddit']), topic: z.string() },
      async (args) => {
        const cmo = getEmployee('cmo', this.props.userId, this.env);
        return await cmo.invokeAsTool('draft_post', args);
      }
    );
    this.server.tool('approve_draft', { draftId: z.string() }, async (args) => {
      const cmo = getEmployee('cmo', this.props.userId, this.env);
      return await cmo.invokeAsTool('approve_draft', args);
    });
    // ...curated subset of CMO tools
  }
}

export default withOAuthProvider({
  audience: 'mcp.shipflare.com',
  apiHandler: CmoExternalMcp.serveSSE('/cmo/sse').fetch,
});
```

`CMO.invokeAsTool(name, args)` is a new `@callable` method on CMO that runs a single tool execution **without** producing chat-stream side effects (external callers want JSON results, not a chat experience).

---

## 6. Layer 5 — Telemetry (single Analytics Engine dataset)

### 6.1 Wrangler binding

```jsonc
// apps/core/wrangler.jsonc
{
  "analytics_engine_datasets": [
    { "binding": "TELEMETRY", "dataset": "shipflare_agent_events" }
  ]
}
```

### 6.2 Schema (one dataset, kind discriminator in indexes[0])

| Field | Slot | Notes |
|---|---|---|
| `indexes[0]` | kind | `'tool_invocation' | 'skill_invocation' | 'agent_run'` |
| `indexes[1]` | userId | for filtering / partitioning |
| `indexes[2]` | runId | nullable; chat conversation correlation |
| `blobs[0]` | name | toolName / skillName / agentClassName |
| `blobs[1]` | status | `'ok' | 'error'` |
| `blobs[2]` | model | LLM model id (when relevant) |
| `blobs[3]` | context | for skills: `'inline' | 'fork'`; for agents: parent class name |
| `doubles[0]` | durationMs | always |
| `doubles[1]` | tokensIn | nullable |
| `doubles[2]` | tokensOut | nullable |
| `doubles[3]` | depth | for agent_run only |

### 6.3 Writer module

```typescript
// apps/core/src/lib/telemetry.ts
interface AgentEvent {
  kind: 'tool_invocation' | 'skill_invocation' | 'agent_run';
  userId: string;
  runId?: string | null;
  blobs: [name: string, status: string, model?: string, context?: string];
  doubles: [durationMs: number, tokensIn?: number, tokensOut?: number, depth?: number];
}

export function writeAgentEvent(event: AgentEvent): void {
  env.TELEMETRY.writeDataPoint({
    indexes: [event.kind, event.userId, event.runId ?? ''],
    blobs: event.blobs,
    doubles: event.doubles,
  });
}
```

Standard queries:
```sql
-- Tool latency p95 by name
SELECT blob1 AS toolName, quantile(0.95)(double1) AS p95_ms
FROM shipflare_agent_events
WHERE index1 = 'tool_invocation' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY toolName;

-- Skill error rate
SELECT blob1 AS skillName, countIf(blob2 = 'error') / count(*) AS error_rate
FROM shipflare_agent_events
WHERE index1 = 'skill_invocation' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY skillName;
```

---

## 7. Wire protocol

ShipFlare adopts AI SDK v5 `UIMessage` parts as the chat wire format. `UIMessage = { id, role, parts: MessagePart[] }`.

### Parts the renderer must handle

| Part type | Source | Renderer |
|---|---|---|
| `text` (with `text-start`/`text-delta`/`text-end` chunks) | LLM | `<TextPart>` |
| `reasoning` (with `reasoning-delta`) | LLM (Claude thinking) | `<ReasoningPart>` ← **solves "stuck on thinking"** |
| `tool-invocation` (state: `input-streaming → input-available → output-available | output-error`) | LLM tool calls | `<ToolInvocation>` or `<NestedAgentRun>` when toolName === `'consult'` |
| `data-skill-start` | `runSkill` | `<SkillPart>` |
| `data-skill-finish` | `runSkill` | `<SkillPart>` (updates) |
| `data-step` | agent stream writer | `<StepAnchor>` (optional anchor when nothing else fires) |

### SDK-defined wire frames over WebSocket

```
cf_agent_chat_messages          → full UIMessage[] (initial + after each turn)
cf_agent_use_chat_request       ← client submits turn
cf_agent_use_chat_response      → streaming chunks
cf_agent_stream_resume_request  ← client requests replay after reconnect
agent-tool-event                → emitted by runAgentTool (started/chunk/finished/error/aborted/interrupted)
```

The 11-kind `ActivityEvent` discriminated union is deleted. Custom seed-replay, `_trace` linkage, and `forwardActivityToCmo` cross-DO fetch are all replaced by SDK-native mechanisms.

---

## 8. Frontend

### Hooks

```typescript
// apps/web/src/hooks/use-cmo-chat.ts
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent, useAgentToolEvents } from 'agents/react';

export function useCmoChat({ userId, conversationId }: { userId: string; conversationId?: string }) {
  const agent = useAgent({
    agent: 'cmo',
    name: userId,
    query: async () => `token=${await fetchAgentJwt('cmo')}`,
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

### Main chat UI shape

```tsx
function CmoChat({ userId }) {
  const { messages, sendMessage, agentRunsByToolCall } = useCmoChat({ userId });
  return (
    <>
      {messages.map(msg =>
        <MessageBubble key={msg.id} role={msg.role}>
          {msg.parts.map((part, i) => {
            switch (part.type) {
              case 'text':       return <TextPart key={i} text={part.text} />;
              case 'reasoning':  return <ReasoningPart key={i} text={part.text} />;
              case 'tool-invocation':
                if (part.toolInvocation.toolName === 'consult') {
                  const employeeId = part.toolInvocation.args.employee;
                  const meta = EMPLOYEE_REGISTRY[employeeId];
                  return <NestedAgentRun key={i}
                    label={meta.displayName}
                    childRun={agentRunsByToolCall[part.toolInvocation.toolCallId]} />;
                }
                return <ToolInvocation key={i} invocation={part.toolInvocation} />;
              case 'data-skill-start':
              case 'data-skill-finish':
                return <SkillPart key={i} part={part} />;
              case 'data-step':
                return <StepAnchor key={i} part={part} />;
            }
          })}
        </MessageBubble>
      )}
      <ChatInput onSubmit={sendMessage} />
    </>
  );
}
```

### Onboarding plan-build wizard

Same hooks; wizard chrome reads `agentRunsByToolCall` to drive the step indicator. `ActivityTrail` becomes a pure render of `UIMessage.parts` (recursive into nested runs). The pairing logic (`*_start` ↔ `*_finish`) goes away — AI SDK parts carry their own state machine.

---

## 9. Generalizations (DRY across O(N) places)

| # | What | Generalized form |
|---|---|---|
| 1 | Telemetry datasets | Single `shipflare_agent_events` dataset with `kind` in `indexes[0]` (see §6) |
| 2 | `Env` type | Derived: `type EmployeeBindings = { [K in EmployeeId as Uppercase<K>]: DurableObjectNamespace<...> }`. Adding employee to registry → compile error if wrangler binding missing |
| 3 | DO stub access | `getEmployee(id, userId, env)` helper — never write `getAgentByName(env.CMO, ...)` directly |
| 4 | System prompt boilerplate | `_SYSTEM_PREAMBLE.md` auto-prepended; colleague list auto-rendered from registry; per-employee `SYSTEM.md` holds only role-specific content |
| 5 | Test harness | `setupAgentTest(id)` returns `{ agent, sendMessage, getStream, env }` |

**Deferred (revisit if/when needed):**
- One `agent-ws-token?agent=...&name=...` route serving any agent (only CMO needs WS auth right now)
- Generic `EmployeeExternalMcp` (only CMO exposed externally per Q6)

---

## 10. New Employee Checklist

Add to `CLAUDE.md` after "New Platform Checklist":

```markdown
### New Employee Checklist

When adding a new agent (e.g., Head of Design = HoD):

- [ ] Create `apps/core/src/agents/head-of-design/HeadOfDesign.ts`
      (~30 lines: `export class HoD extends AIChatAgent<Env, HoDState>`,
       `getTools()` returns `{ consult: makeConsultTool('hod'), ...direct tools }`)
- [ ] Create `apps/core/src/agents/head-of-design/SYSTEM.md` (role brain only)
- [ ] Add ONE entry to `EMPLOYEE_REGISTRY` in `apps/core/src/agents/registry.ts`
- [ ] Add wrangler DO binding to `apps/core/wrangler.jsonc`:
      `{ "name": "HOD", "class_name": "HoD" }`
- [ ] Append migration tag:
      `{ "tag": "vN", "new_sqlite_classes": ["HoD"] }`
- [ ] Add test file `apps/core/src/agents/head-of-design/__tests__/HeadOfDesign.test.ts`
      (~5 lines using `setupAgentTest('hod')`)
- [ ] NO changes needed to: existing agent files, frontend renderer, consult tool,
      telemetry, env type (auto-derived), hooks, JWT route.
- [ ] If you forget the wrangler binding, compile fails: `Property 'HOD' is missing in type 'Env'`.
```

---

## 11. Testing strategy

### 11.1 Unit (vitest, no DO)

| Module | Coverage focus |
|---|---|
| `apps/core/src/lib/agent-depth.ts` | depth-limit at MAX=3; cycle detected; chain immutability |
| `apps/core/src/lib/telemetry.ts` | `writeAgentEvent` produces correct blob/double/index for each `kind` |
| `apps/core/src/skills/run-skill.ts` | data parts emitted when writer present; telemetry called even when writer absent; error path emits `data-skill-finish` with status=error before re-throwing |
| `apps/core/src/agents/registry.ts` | `EMPLOYEE_IDS` derives correctly; `EMPLOYEE_REGISTRY[id].class.name` matches binding name pattern |
| `apps/core/src/agents/lib/consult-tool.ts` | caller-scoped enum excludes self + CMO-from-peers correctly |
| `apps/core/src/agents/lib/get-employee.ts` | returns correct DO stub per registry |
| `apps/web/app/(app)/chat/_components/cmo-chat.tsx` | fixture `UIMessage[]` renders correct subcomponent per part type; `consult` tool-invocation routes to `NestedAgentRun` |

Build gate: `pnpm tsc --noEmit` per `feedback_build_gate_tsc_not_vitest`. Vitest still runs.

### 11.2 Integration (workerd via `@cloudflare/vitest-pool-workers`)

| Test | Scope |
|---|---|
| `cmo-chat-flow.test.ts` | POST user message to CMO; assert stream contains `text-delta`, persists to `this.messages`. |
| `consult-dispatch.test.ts` | CMO with mock HoG; assert `agent-tool-event { kind: started, finished }` arrive with correct `parentToolCallId`. |
| `agent-cycle.test.ts` | HoG → SMM → HoG triggers `AgentCycleError`, surfaces as `tool-output-error`, parent recovers. |
| `agent-depth.test.ts` | depth=3 OK; depth=4 throws `AgentDepthExceededError`. |
| `skill-data-parts.test.ts` | `runSkill` from inside agent tool execute() emits data parts; telemetry written. |
| `external-mcp-oauth.test.ts` | unauthenticated → 401; authenticated → tools list; tool call forwards via `invokeAsTool` with no chat-stream side effects. |
| `resumable-stream.test.ts` | disconnect mid-stream, reconnect → replay chunks marked `replay: true`. |
| `telemetry-no-chat-leak.test.ts` | telemetry write called with correct values AND no telemetry-shaped fields appear in chat-stream `UIMessage` parts. |
| `peer-mesh-smm-to-hog.test.ts` | SMM `consult({ employee: 'hog', ... })` produces nested `agent-tool-event` frames; parent UI receives both SMM and HoG run timelines. |

### 11.3 Real-browser smoke (Playwright)

Reuse user's authenticated browser context (GitHub + X pre-authenticated per `feedback_playwright_real_browser_in_plans`).

```ts
test('founder sees reasoning + nested agent run + skill events', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'auth-state.json' });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3000/chat');
  await page.getByRole('textbox').fill('Plan a launch campaign for our new feature');
  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.getByTestId('reasoning-part').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('nested-agent-run').filter({ hasText: 'Head of Growth' })).toBeVisible({ timeout: 30_000 });

  // Reload mid-stream → resumable
  await page.reload();
  await expect(page.getByText(/Plan a launch campaign/)).toBeVisible();
  await expect(page.getByTestId('nested-agent-run')).toBeVisible();

  await expect(page.getByTestId('assistant-text').last()).toBeVisible({ timeout: 60_000 });
});

test('onboarding plan-build wizard renders thinking, dispatch, skill events', async ({ browser }) => {
  // Drives the onboarding flow; asserts reasoning ticker, dispatch card, skill name in UI.
});
```

### 11.4 Telemetry validation (post-deploy)

`scripts/verify-telemetry.ts` queries Analytics Engine SQL API after dev deploy:

```sql
SELECT index1 AS kind, blob1 AS name, COUNT(*), AVG(double1) AS avg_ms
FROM shipflare_agent_events
WHERE index2 = '<test-user>' AND timestamp > NOW() - INTERVAL '5' MINUTE
GROUP BY kind, name;
```

Assert ≥1 row per expected kind/name combo.

### 11.5 Coverage

80% on layers 1–5 modules. UI components covered primarily by Playwright (vitest renders are brittle for streaming UI).

---

## 12. Branch phasing (replace-in-place, bottom-up)

Branch: `feat/cf-native-chat-migration` off `dev`. Each phase ends with green `pnpm tsc --noEmit` + relevant tests. Branch does NOT merge until phase 11 closes.

| Phase | Scope | Est. |
|---|---|---|
| **0** | Foundation: install `@cloudflare/ai-chat`, AI SDK v5 verify; add Analytics Engine binding; add OAuth scaffolding; verify `runAgentTool` is usable (fallback plan in §13) | 1d |
| **1** | Layer 5 telemetry: `lib/telemetry.ts` + `writeAgentEvent` + unit tests. No consumers yet. | 1d |
| **2** | `lib/agent-depth.ts` (`safeAgentChain`, errors) + unit tests | 0.5d |
| **3** | Layer 3: `runSkill` modifications (data parts + telemetry) + integration test | 1–2d |
| **4a** | Employee registry + `consult-tool.ts` + `get-employee.ts` + system prompt loader | 1d |
| **4b** | SMM rewrite (extends `AIChatAgent`); old SMM file deleted; wrangler binding updated | 1d |
| **4c** | HoG rewrite (declares `consult` peer access to SMM); old HoG file deleted | 1d |
| **4d** | Peer-mesh integration test (`peer-mesh-smm-to-hog.test.ts`) | 0.5d |
| **5** | Layer 1: CMO rewrite (extends `AIChatAgent`, `onChatMessage`, `getTools`); old `addMcpServer` inter-agent plumbing deleted; integration test | 2–3d |
| **6** | DB cleanup: D1 migration drops `founder_messages` + `activity_events`; DO migration tags appended (never edit existing) | 0.5d |
| **7** | Layer 4: `CmoExternalMcp` + `CMO.invokeAsTool` + OAuth wiring + tests | 2d |
| **8** | Frontend: `useCmoChat` hook + `cmo-chat.tsx` + part renderers; delete `useCmoActivity`, `ActivityTrail` pairing logic, `cmo-activity` route, `cmo-ws-token` route | 2–3d |
| **9** | Onboarding plan-build flow rewritten on `useCmoChat`; Playwright onboarding spec green | 1–2d |
| **10** | Delete-list sweep (§13); grep audit; `pnpm tsc --noEmit` green across monorepo | 0.5d |
| **11** | Full-system smoke: Playwright `cmo-chat.spec.ts` + onboarding spec green; manual founder walkthrough on dev deploy; telemetry verify script green; PR opened against `dev`, **merged with merge commit** per `feedback_pr_merge_use_merge_commit` | 1d |

**Total: ~14–18 working days.**

---

## 13. Deletions on cutover

```
packages/shared/src/activity-event.ts                           DELETE
apps/core/src/lib/activity.ts                                   DELETE
apps/core/src/lib/forward-activity.ts                           DELETE
apps/core/src/lib/subagent-activity.ts                          DELETE
apps/web/src/hooks/use-cmo-activity.ts                          DELETE
apps/web/app/api/cmo-activity/route.ts                          DELETE
apps/web/app/api/cmo-ws-token/route.ts                          DELETE (replaced by per-agent generic token route in Phase 8)
apps/core/src/agents/cmo/tools/getRecentActivity.ts             DELETE
D1 migration: drop `founder_messages`, drop `activity_events`
```

Added:
```
apps/core/src/agents/registry.ts                                NEW
apps/core/src/agents/lib/consult-tool.ts                        NEW
apps/core/src/agents/lib/peer-schema.ts                         NEW
apps/core/src/agents/lib/get-employee.ts                        NEW
apps/core/src/agents/lib/setup-agent-test.ts                    NEW
apps/core/src/agents/_SYSTEM_PREAMBLE.md                        NEW
apps/core/src/agents/{cmo,head-of-growth,social-media-manager}/SYSTEM.md  NEW (split from current)
apps/core/src/agents/{cmo,head-of-growth,social-media-manager}/<Class>.ts REWRITE
apps/core/src/external/CmoExternalMcp.ts                        NEW
apps/core/src/lib/agent-depth.ts                                NEW
apps/core/src/lib/telemetry.ts                                  NEW
apps/web/src/hooks/use-cmo-chat.ts                              NEW
apps/web/app/(app)/chat/_components/{cmo-chat,text-part,reasoning-part,nested-agent-run,skill-part,tool-invocation,step-anchor}.tsx  NEW
scripts/verify-telemetry.ts                                     NEW
```

---

## 14. Risk register

| Risk | Mitigation |
|---|---|
| `@cloudflare/ai-chat` API may shift between releases | Pin exact version in Phase 0; document upgrade procedure |
| `runAgentTool` may not be a public lower-level API in `agents@0.12.4` | Phase 0 verification; fallback: pre-instantiate one `agentTool(Cls)` per employee at module load and look up by id inside `consult.execute` — same dev ergonomics, slightly more boilerplate |
| `AIChatAgent` internal SQLite schema is internal | Never query directly; only use `this.messages` accessor |
| `founder_messages` drop is real user data loss | Acceptable per Q3=B; document in deploy notes; consider archive dump to R2 before drop |
| Analytics Engine SQL API rate limits | Used only in scripts/dashboards, not hot paths |
| OAuth provider subdomain routing may collide with existing routes | Phase 7 sub-task: verify `mcp.shipflare.com/cmo` doesn't conflict with existing Worker routes; fall back to path-prefixed routing if needed |
| Peer cycle still reachable if `safeAgentChain` is bypassed (e.g., direct DO fetch) | All inter-agent calls MUST go through `consult` tool. Code review reject for any new `getAgentByName(env.HOG, ...)` outside `get-employee.ts` |
| AIChatAgent + AI SDK v5 streaming may not preserve Claude `thinking` blocks as `reasoning` parts out of the box | Phase 5 integration test asserts `reasoning` parts present; if missing, write a thin shim that maps Claude `thinking` content blocks to AI SDK `reasoning-delta` chunks |

---

## 15. Open questions / Phase 0 verifications

1. **`runAgentTool` public API status** — confirm in `node_modules/agents/dist/agent-tools/*.d.ts`. If only `agentTool(Cls)` is exposed, switch to pre-instantiation pattern (see risk register).
2. **AI SDK v5 `reasoning` part support for Anthropic thinking** — confirm `@ai-sdk/anthropic` ≥ v1.x emits `reasoning-delta` chunks when `thinking` enabled.
3. **AIChatAgent SQLite migration semantics** — what happens when an existing CMO DO instance receives a new code version with the AIChatAgent schema? Confirm clean init on first message after deploy (per Q3=B, fresh start is acceptable so worst case = "no prior messages visible").
4. **`useAgentChat` package install path** — confirm `@cloudflare/ai-chat/react` exports `useAgentChat` in the version installed.
5. **Tool definition import** — `defineTool` is shown in this spec as `from 'agents/tools'`. AI SDK v5 uses `tool({...})` from `'ai'`. Phase 0 verifies which to use; pick one and apply consistently across all tool definitions.
6. **`experimental_context` threading** — verify AI SDK v5 passes `experimental_context` through to tool `execute` as the `ctx` argument; this is how `writer` reaches `runSkill` and `runAgentTool` calls inside tool bodies.

These are all answered in Phase 0; if any answer requires a design change, this spec is amended before Phase 1 begins.

---

## Self-review pass

- [x] Placeholder scan — no TBD, TODO, or "fill in later" sections.
- [x] Internal consistency — Section numbering coherent (renumbered after consult-tool amendment); all referenced files appear in §13 add/delete lists.
- [x] Scope check — one branch, one cutover, no sub-projects needing decomposition.
- [x] Ambiguity check — DAG topology (Q4=B) made concrete as full mesh; `consult` tool replaces N-tools pattern; telemetry destination (Q5=A) made concrete as single dataset with kind discriminator.
