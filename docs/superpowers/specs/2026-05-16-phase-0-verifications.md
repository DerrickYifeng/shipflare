# Phase 0 — SDK Verifications

Source plan: `2026-05-16-cf-native-chat-migration.md` Task 0.2.
Date: 2026-05-16.
Installed versions (from `apps/core/package.json` after Task 0.1):

| Package | Installed |
|---|---|
| `agents` | `0.12.4` |
| `@cloudflare/ai-chat` | `0.7.0` |
| `ai` | `6.0.184` (resolved to `6.0.182` in the lock) |
| `@ai-sdk/anthropic` | `3.0.78` |
| `@ai-sdk/react` | `3.0.186` (transitive via `@cloudflare/ai-chat`) |

## Findings

| # | Question | Answer | Impact on plan |
|---|---|---|---|
| 1 | Is `runAgentTool` exported from `agents` as a free function? | **No.** `agents/agent-tools` exports only `agentTool(cls, options) → Tool` (factory). The runtime dispatcher is `Agent.runAgentTool` (instance method on the parent agent), called internally by `agentTool`. | `consult-tool.ts` must pre-instantiate one `agentTool(employeeClass, {...})` per employee in `EMPLOYEE_REGISTRY`, not call a free `runAgentTool`. The `makeConsultTool(employeeId)` factory returns the pre-bound `Tool`. Confirms the spec's "one tool per employee" approach. |
| 2 | Does `@ai-sdk/anthropic@3.0.78` emit `reasoning-*` stream parts? | **Yes.** `dist/index.js` contains `reasoning-start`, `reasoning-delta`, `reasoning-end` chunk types. | No shim needed. The chat UI's `reasoning-part.tsx` can consume Anthropic reasoning parts directly via the AI SDK v5 stream. |
| 3 | Where does `useAgentChat` live, and does `useAgentToolEvents` exist? | `useAgentChat` is exported from `@cloudflare/ai-chat/react` (NOT the root). **`useAgentToolEvents` does NOT exist.** Nested `agentTool` runs surface as UI message parts in the parent stream; consumers parse `UIMessage.parts` (tool/data parts) using helpers like `getToolPartState`, `getToolCallId`, `getToolInput`, `getToolOutput`. | `apps/web/src/hooks/use-cmo-chat.ts` imports `useAgentChat` from `'@cloudflare/ai-chat/react'`. Drop `useAgentToolEvents` from the design — child agent activity is read off the parent message's parts (typed `tool-*` and `data-*` parts emitted by the `agentTool` forwarder + Skill runner). `nested-agent-run.tsx` renders these by tool name (`consult.<employeeId>`) and tool-call ID. |
| 4 | Does `experimental_context` thread into tool `execute`? | **Yes.** `streamText` and `generateText` both accept `experimental_context: unknown`; the value is available on the tool `execute`'s second arg (`ToolCallOptions.experimental_context`). | Pass `{ userId, depth, parentRunId, ... }` via `experimental_context` from each agent's `streamText` call; `consult` tool's `execute` reads it for `safeAgentChain` depth/cycle checks. |
| 5 | Use `defineTool` or `tool`? | **`tool`.** `defineTool` does not exist in `ai@6` or `agents@0.12.4`. `tool` is re-exported from `'ai'` (originally from `@ai-sdk/provider-utils`). | Plan uses `import { tool } from 'ai'` for every Zod-typed tool definition. `agentTool(cls, {...})` from `'agents/agent-tools'` is used only for sub-agent dispatch tools (the `consult` family). |

## Additional notes (not in the original probe set, but worth recording)

- `agents@0.12.4` exposes `AIChatAgent` from the root, but the canonical import path used by the new code (and matching `@cloudflare/ai-chat`'s docs) is `import { AIChatAgent } from '@cloudflare/ai-chat'`. Both packages export the class; we standardise on `@cloudflare/ai-chat` because it pins the matching `agents/react` + `agents/chat` shims.
- `AIChatAgent` already carries `chatRecovery`, `_agentToolForwarders`, `_agentToolLiveSequences`, and a `_turnQueue` — i.e. nested-agent dispatch, durable streaming, and per-turn serialization are framework-provided. Confirms the spec's claim that we drop the hand-rolled mailbox + slot-yield protocol.
- `useAgentChat` returns `isServerStreaming`, `isToolContinuation`, and `isStreaming` in addition to the standard `useChat` surface — the chat UI's `data-*` part consumers can use these for typing indicators and gap-handling.
- `agents` package exports `agents/chat` (for `ClientToolSchema`) and `agents/react` (for `useAgent`) which `@cloudflare/ai-chat/react` re-uses; no need to add either as an explicit dependency.

## Decision impact summary

No plan amendments required. All five questions resolved in favour of the design as written:

1. `consult-tool.ts` pre-instantiates one `agentTool(Cls, …)` per employee (already implied by §6 of the design).
2. Reasoning parts flow end-to-end without a shim.
3. The hook drops the `useAgentToolEvents` import; nested-agent UI reads `UIMessage.parts` directly.
4. `experimental_context` carries `{ userId, depth, parentRunId, … }` into tool execution.
5. All Zod-typed tools use `tool({...})` from `'ai'`; sub-agent dispatch uses `agentTool(Cls, …)` from `'agents/agent-tools'`.

Proceed to Phase 1.
