# Phase-0c verifications — synthetic-turn API for alarm-driven relay

**Status:** VERIFIED. Implementation pattern locked. Task 5.1c.13 is mechanical.

**Scope:** Lock the exact `@cloudflare/ai-chat` API that the CMO `alarm()` handler will use to programmatically trigger an `onChatMessage` LLM turn (the "synthetic turn" pattern described in `2026-05-17-cf-chat-5-1c-design.md` §3.5).

**SDK probed:** `@cloudflare/ai-chat@0.7.0` (with `agents@0.12.4`, `ai@6.0.184`). Files read:
- `node_modules/.pnpm/@cloudflare+ai-chat@0.7.0_.../dist/index.d.ts`
- `node_modules/.pnpm/@cloudflare+ai-chat@0.7.0_.../dist/index.js` (lines 960–995 `_runProgrammaticChatTurn`, 1391–1417 `saveMessages`, 2274–2331 `_reply`, 1575–1611 `persistMessages`, 546–549 `_broadcastChatMessage`)
- `node_modules/.pnpm/agents@0.12.4_.../dist/chat/index.d.ts` (lines 270–324 `SaveMessagesOptions` / `SaveMessagesResult`)
- `node_modules/.pnpm/ai@6.0.184_.../dist/index.d.ts` (lines 1568–1611 `UIMessage` / `TextUIPart`)

---

## 1. Verified API path

**Use `this.saveMessages(messages, options?)`** — the public, documented method on `AIChatAgent` (declared at `index.d.ts:578`). It is the SDK's blessed entry point for "persist new messages + drive a fresh LLM turn programmatically."

One call covers everything we need:

1. Appends the synthetic message to `this.messages` (via `persistMessages` → `cf_ai_chat_agent_messages` SQLite table).
2. Calls `this._runProgrammaticChatTurn(...)` which invokes our existing `this.onChatMessage(() => {}, { requestId, abortSignal, clientTools, body, continuation: false })` (`index.js:973–980`).
3. Reads the SSE `Response` returned by `onChatMessage` via `this._reply(...)` (`index.js:981`), persists the assistant reply into `cf_ai_chat_agent_messages`, and broadcasts to any connected WS clients (no-op when none are connected — `broadcast()` over zero connections is a noop).

We do NOT need to:
- Provide our own writer — the existing `onChatMessage` builds `createUIMessageStream({ execute: ({ writer }) => streamText({...}) })` and the SDK's `_reply` consumes the returned `Response` body itself via `response.body.getReader()` (`index.js:2291`). No live WS reader required.
- Synthesize a virtual WS pair — `_broadcastChatMessage` calls `this.broadcast()` (Agents SDK), which iterates `this.getConnections()`. Zero connections → zero sends → no error.
- Manually trigger persistence of the assistant reply — `_reply` calls `persistMessages` internally at the end of streaming (`index.js:2274` onward).

**Method signature** (from `index.d.ts:578`):

```ts
saveMessages(
  messages:
    | UIMessage[]
    | ((currentMessages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
  options?: { signal?: AbortSignal }
): Promise<{ requestId: string; status: "completed" | "skipped" | "aborted" }>;
```

Pass a **function** rather than an array so the synthetic message is appended to the latest persisted `this.messages` at the moment the turn runs, not whatever `this.messages` happened to be when `alarm()` started (avoids stale baselines if another turn was queued).

---

## 2. Message shape — exact `UIMessage` for the synthetic system turn

Pin AI SDK v6 `UIMessage` (declared at `ai@6.0.184/dist/index.d.ts:1568`):

```ts
interface UIMessage<METADATA = unknown, ...> {
  id: string;
  role: 'system' | 'user' | 'assistant';
  metadata?: METADATA;
  parts: Array<UIMessagePart<DATA_PARTS, TOOLS>>;
}
```

**Key correction vs. spec §3.5 draft:** The draft snippet used `content: SYNTHETIC_CRON_PROMPT` and `createdAt: <string>`. The real shape is `parts: [{ type: 'text', text: SYNTHETIC_CRON_PROMPT }]`. There is no `content` or `createdAt` field on `UIMessage` in AI SDK v6. (`createdAt` goes inside `metadata` if you want a timestamp — it round-trips through SQLite untouched.)

**Correct synthetic message:**

```ts
const synthetic: UIMessage = {
  id: `relay-${crypto.randomUUID()}`,
  role: 'system',
  parts: [{ type: 'text', text: SYNTHETIC_CRON_PROMPT }],
  metadata: { source: 'daily-relay', firedAt: new Date().toISOString() },
};
```

- `role: 'system'` is supported by the type union and persists through `convertToModelMessages` to the provider as a system prompt segment. The AI SDK docs note "system messages should be avoided (set the system prompt on the server instead)" — that's a UI-layer convention, not a runtime constraint. We deliberately use `system` so 5.1c.17's `MessageList` filter (`m.role !== 'system' || m.metadata?.source !== 'daily-relay'`) hides the synthetic input from the founder while still rendering the assistant's reply.
- `metadata` is typed `unknown` by default and round-trips through SQLite. Use it for `source: 'daily-relay'` (filter discriminator) and any local relay metadata (`firedAt`, `relayHourLocal`, etc.).

---

## 3. Writer handling — no WS client connected

**No-op by design.** The existing `onChatMessage` is invoked unchanged with a no-op `onFinish`:

```js
// from @cloudflare/ai-chat dist/index.js:973–980
const response = await this.onChatMessage(() => {}, {
  requestId,
  abortSignal,
  clientTools,
  body,
  continuation: false,
});
if (response) await this._reply(requestId, response, [], { chatMessageId: requestId });
```

The `writer` is created inside our own `createUIMessageStream({ execute: ({ writer }) => ... })` (`apps/core/src/agents/cmo/CMO.ts:90–115`) and consumed by the returned `Response` body. The SDK's `_reply` reads that body via `response.body.getReader()` and:
- Broadcasts deltas to all `this.getConnections()` (zero connections → silent no-op).
- Persists the final assistant message to `cf_ai_chat_agent_messages` once streaming finishes (`index.js:2332` onward).

Net: **no special writer handling required** in the alarm path. Reuse `onChatMessage` exactly as it stands for WS clients.

---

## 4. Persistence guarantee

Both messages persist into the existing CMO SQLite tables, so the next WS client to connect picks them up via the standard hydration path:

| When | What | Table | Verified at |
|------|------|-------|-------------|
| Before LLM turn | Synthetic system message | `cf_ai_chat_agent_messages` | `index.js:1404` (`persistMessages(resolvedMessages)`) |
| After LLM turn | Assistant reply (incl. tool calls, plan_items, etc.) | `cf_ai_chat_agent_messages` | `index.js:2332+` (end of `_reply`) |

`_lastBody` and `_lastClientTools` (request context) are also restored from SQLite on hibernation (`index.js:1393–1394` reuses whatever the last WS chat persisted). For the alarm path they are typically `undefined` on a cold DO, which is correct — the synthetic turn has no `body` or `clientTools` since no client sent it.

---

## 5. Code snippet — paste into `runRelayTurn()` for 5.1c.13

Drop this into the CMO alarm path (tabs, matches `apps/core/src/agents/cmo/CMO.ts` indent convention):

```ts
import type { UIMessage } from "ai";

const SYNTHETIC_CRON_PROMPT = `It is your scheduled daily relay window for {{TZ_LOCAL}} {{RELAY_HOUR}}:00.

Review the founder context, strategic path, and pending plan_items. Decide today's plays: invoke SMM/HoG via the consult tool for discovery + drafting work. Summarise what you scheduled for the founder so they see the plan when they next open /chat.`;

/**
 * Drive a headless LLM turn from alarm(). Persists a synthetic system
 * message + runs onChatMessage exactly like a WS chat-request would,
 * but without a connected client. Assistant reply auto-persists into
 * cf_ai_chat_agent_messages and renders when the founder next opens /chat.
 *
 * @internal Verified Phase-0c — see docs/superpowers/specs/2026-05-17-phase-0c-verifications.md
 */
private async runRelayTurn(ctx: {
	relayHourLocal: number;
	tz: string;
	firedAt: string;
}): Promise<void> {
	const prompt = SYNTHETIC_CRON_PROMPT
		.replace("{{TZ_LOCAL}}", ctx.tz)
		.replace("{{RELAY_HOUR}}", String(ctx.relayHourLocal).padStart(2, "0"));

	const synthetic: UIMessage = {
		id: `relay-${crypto.randomUUID()}`,
		role: "system",
		parts: [{ type: "text", text: prompt }],
		metadata: {
			source: "daily-relay",
			firedAt: ctx.firedAt,
			relayHourLocal: ctx.relayHourLocal,
			tz: ctx.tz,
		},
	};

	// Pass a function (not an array) so the synthetic is appended to the
	// latest persisted messages at turn-start, not whatever this.messages
	// was when alarm() began.
	const result = await this.saveMessages(
		(current) => [...current, synthetic],
	);

	writeAgentEvent(this.env, {
		kind: "relay-completed",
		userId: this.name,
		blobs: ["CMO", result.status, result.requestId],
	});
}
```

The alarm handler in 5.1c.13 will wrap this with try/catch + `relay-failed` telemetry on throw + `setAlarm()` rescheduling for tomorrow's relay window.

---

## 6. Failure modes & self-healing

| Failure | Cause | Detection | Recovery |
|---------|-------|-----------|----------|
| `status: "skipped"` | A WS client sent `chat-clear` between `persistMessages` and `_runProgrammaticChatTurn` (bumps `_turnQueue.generation`). | Returned from `saveMessages`. | Treat as success — founder explicitly cleared the chat. Log `relay-skipped` telemetry; do NOT retry today. Reschedule for tomorrow as normal. |
| `status: "aborted"` | External abort signal fired mid-stream, or `chat-request-cancel` arrived over WS. | Returned from `saveMessages`. | Log `relay-aborted` telemetry. Partial assistant reply IS persisted (`index.js:2299` — partial chunks survive abort). Reschedule for tomorrow. |
| `onChatMessage` throws (LLM 429, network, anthropic outage) | Provider error. | `saveMessages` rejects. | Catch in alarm handler. Log `relay-failed` with `err.message.slice(0, 200)`. Reschedule for tomorrow — don't retry inside the same alarm window. |
| DO destroyed mid-stream | DO eviction during inference. | `this.destroy()` cancels pending requests (`index.js:803`). Resumes via `onChatRecovery` only if `chatRecovery: true` is set on the agent. | CMO currently doesn't set `chatRecovery: true` — partial reply is lost. Acceptable for v1; revisit if relays start producing long replies. (Spec §3.5 R6 already calls this out.) |
| Synthetic appended twice (double-fire) | Two `alarm()` invocations scheduled (shouldn't happen — `setAlarm()` replaces). | Two `relay-completed` events at the same `firedAt`. | Defended by `setAlarm` replacement semantics (spec §3.7 R7). If observed, add idempotency check via `metadata.firedAt` lookup in `this.messages`. |

**No WS client connected** is not a failure mode — it's the expected steady state for alarm-driven turns. `broadcast()` over zero connections is silent no-op; assistant reply still persists.

---

## 7. Open caveats for 5.1c.13

1. **`createdAt` belongs in `metadata`, NOT at the top level of `UIMessage`** (AI SDK v6 dropped the field). Spec §3.5's draft snippet should be updated; the implementation snippet above is authoritative.
2. **Use a function form for `saveMessages`** — `(current) => [...current, synthetic]` — to avoid stale-baseline bugs if another turn raced into the queue while alarm() was preparing.
3. **`writeAgentEvent` kind names** in 5.1c.13 should match the spec's telemetry section: `relay-fired` (before invoking), `relay-completed` (on success), `relay-skipped` / `relay-aborted` (terminal non-error), `relay-failed` (on throw).
4. **No need for `experimental_context` changes** — the existing `onChatMessage` already threads `{ writer, userId, env }`. The alarm path inherits this verbatim because it calls the same method.
5. **Synthetic message ID format** — use `relay-${crypto.randomUUID()}` (not `relay-${Date.now()}` from the spec draft) so two alarms in the same millisecond don't collide. SQLite primary key on `id` would reject the second otherwise.
