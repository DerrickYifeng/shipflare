# Engine → src Migration Plan

## Context

ShipFlare's agent infrastructure currently lives in two places:
1. **`engine/`** — A Claude Code fork containing battle-tested multi-agent patterns (query loop, tool system, swarm coordination, memory, MCP)
2. **`src/bridge/`** — A thin adaptation layer (~600 lines) that re-implements a subset of engine patterns for headless use

The bridge works but leaves significant engine value on the table: no streaming, no error recovery, no proper swarm coordination, no agent memory, no MCP. The goal is to port the key engine modules into `src/` so ShipFlare's agents gain these capabilities while remaining headless (no terminal UI, no ink, no vim mode).

Per user feedback (memory: `feedback_preserve_claude_code_arch.md`): maximize reuse of engine code — adapt, don't rewrite.

---

## Target Architecture

```
src/
├── core/                         # Engine core (ported)
│   ├── api-client.ts             # Anthropic API: streaming, caching, retries, cost
│   ├── query-loop.ts             # Async generator query loop
│   ├── tool-system.ts            # Tool interface + buildTool + ToolRegistry
│   ├── tool-executor.ts          # Concurrent/serial batched tool execution
│   ├── swarm.ts                  # Multi-agent coordinator (fan-out + pipeline)
│   └── types.ts                  # Core shared types
├── memory/                       # Agent memory (ported from engine/memdir/, Supabase-backed)
│   ├── store.ts                  # Supabase-backed memory store (replaces filesystem)
│   ├── retrieval.ts              # Relevance-based side-query retrieval
│   ├── dream.ts                  # Auto-dream daily log + nightly distill
│   ├── prompt-builder.ts         # Memory prompt injection into system prompts
│   └── types.ts                  # Memory types
├── mcp/                          # MCP integration (ported)
│   ├── client.ts                 # Headless MCP client (no terminal UI)
│   ├── manager.ts                # Connection lifecycle + reconnection
│   ├── tool-loader.ts            # Progressive tool discovery from MCP servers
│   └── types.ts                  # MCP types
├── agents/                       # Agent definitions (unchanged)
│   ├── query.md
│   ├── discovery.md
│   ├── content.md
│   ├── posting.md
│   └── schemas.ts
├── tools/                        # Tool implementations (add registry)
│   ├── registry.ts               # NEW: central tool registry
│   ├── reddit-search.ts
│   ├── reddit-post.ts
│   ├── reddit-verify.ts
│   ├── url-scraper.ts
│   └── seo-audit.ts
├── bridge/                       # Simplified adapter layer
│   ├── agent-runner.ts           # Thin wrapper around core/query-loop
│   ├── load-agent.ts             # Keep: markdown agent loader
│   └── memory-bridge.ts          # Combines DB product context + memory/store
├── workers/                      # Background jobs (updated imports)
├── app/                          # Next.js app (updated imports)
└── lib/                          # Shared infra (unchanged)
```

---

## Phase 1: Core Query Loop + Tool System

### 1.1 Create `src/core/types.ts`

Port types from engine, stripping CLI/terminal concerns.

**From `engine/Tool.ts` (lines 1-100):**
- `ToolDefinition` — name, description, inputSchema (Zod), outputSchema, execute fn, isConcurrencySafe, isReadOnly, maxResultSizeChars
- `ToolResult` — content blocks (text/image), isError flag
- `ToolContext` — abortSignal, dependencies map, messages ref

**From `engine/query.ts` (lines 1-50):**
- `StreamEvent` — union: `tool_start | tool_done | text_delta | turn_complete | error`
- `QueryParams` — messages, systemPrompt, tools, model, maxTurns, taskBudget, onProgress

**From `src/bridge/types.ts` (keep and extend):**
- `AgentConfig` — name, systemPrompt, model, tools, maxTurns, outputSchema
- `AgentResult<T>` — output, usage (inputTokens, outputTokens, costUsd, model, turns)
- `AgentProgressEvent` — existing SSE event types
- `MODEL_PRICING` — per-model token costs

**Strip:** React/ink rendering callbacks, permission UI, file state cache, app state, vim bindings

### 1.2 Create `src/core/api-client.ts`

Port API call infrastructure from engine, critical for reliability and cost.

**From `engine/services/api/claude.ts`:**
- Raw streaming: use `Stream<RawMessageStreamEvent>` instead of `MessageStream` to avoid O(n^2) partial JSON parsing
- Prompt cache control: `cache_control: { type: 'ephemeral' }` on system prompt blocks for Anthropic prompt caching (5-min TTL, significant cost savings)
- Structured output: `output_format: { type: 'json_schema', schema }` for guaranteed JSON (engine uses `BetaJSONOutputFormat`)

**From `engine/services/api/withRetry.ts`:**
- `withRetry()` wrapper for API calls:
  - 529 (overloaded): max 3 retries, fallback to non-streaming
  - 429 (rate limit): exponential backoff with jitter (base 500ms)
  - Connection errors (ECONNRESET, SSL/TLS): retry with backoff
  - `CannotRetryError` for fatal errors (auth, invalid request)

**From `engine/utils/sideQuery.ts`:**
- `sideQuery()` — lightweight parallel API call for non-primary queries (memory retrieval, tool use summaries). Used by memory retrieval (Phase 3). Port as a standalone utility.

**New: Cost tracking (from `engine/cost-tracker.ts`):**
- Track per-model usage: input tokens, output tokens, cache read tokens, cache write tokens
- USD cost calculation including cache pricing
- Session-level aggregation across all agent calls

```typescript
export interface UsageTracker {
  add(usage: MessageUsage, model: string): void
  getCost(): number
  getBreakdown(): { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }[]
}
```

### 1.3 Create `src/core/tool-system.ts`

**Port `buildTool()` from `engine/Tool.ts` line ~783:**
- Merge with current `src/bridge/build-tool.ts` (46 lines)
- Keep ShipFlare's **flat format** (one .ts file per tool, no folder-per-tool like engine)
- Add engine fields with fail-closed defaults:
  - `isConcurrencySafe: false` — must opt-in to parallel execution
  - `isReadOnly: false` — must opt-in to mark as side-effect-free
  - `maxResultSizeChars: 100_000` — auto-truncate oversized tool results
  - `shouldDefer: false` — for progressive loading (MCP tools)
  - `aliases?: string[]` — alternative names for tool lookup
- Keep `toAnthropicTool()` Zod→JSON Schema conversion

**New: `ToolRegistry` class:**
```
register(tool: ToolDefinition)        — add tool
get(name: string)                     — lookup by name or alias
getAll()                              — all tools
getForAgent(names: string[])          — subset matching agent config
loadFromMCP(tools: ToolDefinition[])  — batch register MCP-discovered tools
```

**Tool format decision:** Keep ShipFlare's flat .ts format. Engine's folder-per-tool pattern exists because each tool needs UI.tsx (ink terminal rendering) + prompt.ts + permissions — none of which apply to headless agents. ShipFlare tools stay as single files with `buildTool({ name, description, inputSchema, execute })`.

**Replaces:** `src/bridge/build-tool.ts` (absorbed)

### 1.4 Create `src/core/tool-executor.ts`

**Port from engine's `StreamingToolExecutor` + `toolOrchestration.ts`:**

Key functions:
- `partitionToolCalls(blocks, registry)` — group tool_use blocks into batches:
  - All concurrent-safe → one parallel batch
  - Any non-concurrent → serial batch boundaries
- `async function* executeTools(batches, registry, context)` — async generator:
  - Yield `tool_start` event per tool
  - Execute batch (parallel if concurrent-safe, serial otherwise)
  - Yield `tool_done` event with result
  - Support `AbortController` cancellation
  - Sibling abort: one tool failure cancels batch peers
  - Respect `maxResultSizeChars` truncation

**Replaces:** inline `partitionToolCalls` + `executeToolBlock` in `src/bridge/agent-runner.ts` lines 80-140

### 1.5 Create `src/core/query-loop.ts`

**Port core loop from `engine/query.ts` (lines 248-1409), stripped of CLI concerns:**

```typescript
export async function* queryLoop(params: QueryParams): AsyncGenerator<StreamEvent, QueryResult>
```

Core loop logic:
1. Build initial messages array
2. Call API via `api-client.ts` with raw streaming + prompt cache control
3. Collect response: text blocks + tool_use blocks
4. If tool_use blocks:
   a. Partition and execute via `tool-executor.ts`
   b. Yield stream events for each tool
   c. Append tool results to messages
   d. Check turn budget (maxTurns, taskBudget)
   e. Continue loop
5. If `stop_reason === 'end_turn'`:
   a. If outputSchema defined → use structured output (json_schema) for guaranteed parsing
   b. Fallback: extract JSON from markdown code blocks (current behavior)
   c. Return result

**Error recovery (delegated to api-client.ts `withRetry()`):**
- `413 prompt_too_long` — truncate older tool results, retry
- `max_output_tokens` — escalate: 8k → 16k → 64k, max 3 retries
- `429 rate_limit` — exponential backoff with jitter (via withRetry)
- `529 overloaded` — retry with non-streaming fallback (via withRetry)

**Prompt caching strategy:**
- System prompt: `cache_control: { type: 'ephemeral' }` on static portions
- Tool definitions: cached (they don't change between turns)
- Messages: only cache large context blocks (product info, memory)
- This alone can reduce cost 50-90% for multi-turn agents

**Convenience wrapper:**
```typescript
export async function runAgent<T>(config: AgentConfig, context: RunContext): Promise<AgentResult<T>>
```
- Collects all events from `queryLoop()`, returns final result
- Optional `onProgress` callback routes events to SSE
- Tracks usage via `UsageTracker` from api-client.ts

**Strip from engine:** auto-compaction (stateless agents), stop hooks, tombstone messages, skill discovery, queued commands, streaming UI render
**Keep from engine:** tool execution loop, error recovery, turn budget, cost tracking, JSON extraction, prompt caching, structured output

**Replaces:** `src/bridge/agent-runner.ts` (263 lines → thin wrapper)

---

## Phase 2: Swarm Coordinator

### 2.1 Create `src/core/swarm.ts`

**Port pattern from `engine/coordinator/coordinatorMode.ts` (370 lines):**

```typescript
export class SwarmCoordinator {
  constructor(config: SwarmConfig)

  // Fan-out: run N agents in parallel with concurrency limit
  async fanOut<T>(tasks: AgentTask[]): Promise<AgentResult<T>[]>

  // Pipeline: sequential phases, each can fan-out internally
  async pipeline<T>(phases: Phase[]): Promise<T>
}
```

**SwarmConfig:**
- `maxConcurrency: number` (default 5)
- `timeoutPerAgent: number` (default 60_000ms)
- `onProgress?: OnProgress`
- `toolRegistry: ToolRegistry`

**AgentTask:**
- `agentName: string` — references an agent .md definition
- `input: Record<string, unknown>` — template variables for system prompt
- `tools?: string[]` — tool names from registry (override agent defaults)
- `context?: Record<string, unknown>` — extra context injection

**Phase (for pipeline):**
- `name: string`
- `tasks: AgentTask[] | ((prevResults) => AgentTask[])` — static or dynamic
- `synthesis?: (results: AgentResult[]) => unknown` — coordinator synthesizes between phases

**Key behaviors (ported from engine AgentTool + coordinator):**
- Concurrency-limited via semaphore (p-limit pattern)
- Error isolation: one agent failure → error result, others continue
- Per-agent timeout via `AbortController.timeout()`
- Abort controller hierarchy: parent abort cascades to all child agents (from engine's `createChildAbortController` pattern)
- Agent name registry: `Map<name, agentId>` for routing (from engine's `appState.agentNameRegistry`)
- Aggregated usage tracking across all workers
- Progress events per-agent for SSE streaming
- Task state tracking: pending → running → completed/failed/killed (from engine's TaskState pattern)

### 2.2 Refactor `src/workers/processors/discovery.ts`

Replace ad-hoc `Promise.all` with `SwarmCoordinator.fanOut()`:

```
Before: Promise.all(subreddits.map(sub => runAgent('discovery', ...)))
After:  coordinator.fanOut(subreddits.map(sub => ({ agentName: 'discovery', input: { subreddit: sub, ... }, tools: ['reddit_search'] })))
```

### 2.3 Refactor `src/app/api/scan/route.ts`

Replace inline fan-out + SSE wiring with coordinator + queryLoop events:
- Use `queryLoop()` generator to stream events natively
- Use `coordinator.fanOut()` for parallel discovery agents
- SSE events flow from `StreamEvent` → `AgentProgressEvent` → `text/event-stream`

---

## Phase 3: Memory System

### 3.1 Create `src/memory/types.ts`

**Port from `engine/memdir/memoryTypes.ts`:**
- `MemoryType = 'user' | 'feedback' | 'project' | 'reference'`
- `MemoryEntry` — name, description, type, content, filePath, mtimeMs
- `MemoryHeader` — name, description, type, filename, mtimeMs (no content, for listing)
- `MemoryConfig` — baseDir, maxEntrypointLines (200), maxEntrypointBytes (25_000)

### 3.2 Create `src/memory/store.ts` — Supabase-backed

Engine uses filesystem (two-tier: MEMORY.md + topic files). ShipFlare deploys on Vercel (ephemeral filesystem), so memory must be **Supabase/PostgreSQL-backed**.

**New DB schema (`src/lib/db/schema/memories.ts`):**

```sql
-- Replaces engine's MEMORY.md + topic .md files
CREATE TABLE agent_memories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,              -- e.g. "audience_pain_points"
  description TEXT NOT NULL,       -- one-line summary (for relevance matching)
  type TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
  content TEXT NOT NULL,           -- full memory body
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, name)        -- one memory per name per product
);

-- Replaces engine's daily log files
CREATE TABLE agent_memory_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  entry TEXT NOT NULL,             -- timestamped insight
  logged_at TIMESTAMPTZ DEFAULT NOW(),
  distilled BOOLEAN DEFAULT FALSE  -- marked true after dream distillation
);

-- Track distillation state per product
ALTER TABLE products ADD COLUMN last_distill_at TIMESTAMPTZ;
```

**MemoryStore API (same interface, DB backend):**

```typescript
export class MemoryStore {
  constructor(productId: string)

  // Index — replaces MEMORY.md. Builds index string from DB query
  loadIndex(): Promise<string>
    // SELECT name, description FROM agent_memories WHERE product_id = ?
    // Format as "- [name](name) — description" per line
    // Apply truncation (engine's MAX_ENTRYPOINT_LINES / MAX_ENTRYPOINT_BYTES)

  // Entries
  listEntries(): Promise<MemoryHeader[]>
  loadEntry(name: string): Promise<MemoryEntry>
  saveEntry(entry: Omit<MemoryEntry, 'id'>): Promise<void>  // upsert by name
  removeEntry(name: string): Promise<void>

  // Logs (for dream system)
  appendLog(entry: string): Promise<void>
  getRecentLogs(since: Date): Promise<string[]>
  getUndistilledLogCount(): Promise<number>      // for threshold trigger
  markLogsDistilled(before: Date): Promise<void>  // after distillation
}
```

**Supabase MCP integration option:** The Supabase MCP server could let agents query/write memories directly as a tool — investigate in Phase 4 whether `@supabase/mcp` can replace custom store code. If viable, agents could use a `memory_search` MCP tool instead of the side-query approach.

### 3.3 Create `src/memory/retrieval.ts`

**Port from `engine/memdir/findRelevantMemories.ts` (142 lines):**

```typescript
export async function findRelevantMemories(
  query: string,
  store: MemoryStore,
  signal: AbortSignal,
): Promise<MemoryEntry[]>
```

- Scan all memory headers via `store.listEntries()`
- Format as manifest (filename + description per line)
- Side-query to Haiku (cheaper than engine's Sonnet) with structured output:
  - System: "Select up to 5 memories relevant to this query"
  - Input: query + manifest
  - Output: `{ selected_memories: string[] }`
- Load and return full entries for selected filenames

### 3.4 Create `src/memory/dream.ts` — Auto-Dream (Supabase-backed)

Engine's auto-dream relies on filesystem daily logs + nightly distillation. ShipFlare adapts this for Supabase with a hybrid trigger strategy.

**Port from `engine/memdir/memdir.ts` `buildAssistantDailyLogPrompt` (lines 327-370):**

```typescript
export class AgentDream {
  constructor(private store: MemoryStore)

  // --- Phase A: Lightweight logging during agent runs ---
  // Called after each agent run (discovery/content/posting)
  // Just an INSERT, no LLM call — zero latency impact
  async logInsight(entry: string): Promise<void>
    // store.appendLog(entry)
    // Examples of what gets logged:
    //   "r/SaaS mostly show-and-tell, low intent — deprioritize"
    //   "'spending hours on X' query pattern highest hit rate in r/webdev"
    //   "casual first-person tone → avg confidence 0.82 in r/startups"
    //   "shadowban detected after 3 rapid posts to same subreddit"

  // --- Phase B: Threshold check (after each agent run) ---
  // Returns true if distillation should be triggered
  async shouldDistill(): Promise<boolean>
    // SELECT COUNT(*) FROM agent_memory_logs
    //   WHERE product_id = ? AND logged_at > last_distill_at
    // Trigger if count >= 20

  // --- Phase C: Distillation (runs in BullMQ worker) ---
  async distill(): Promise<void>
    // 1. Load recent logs from agent_memory_logs
    //    SELECT entry FROM agent_memory_logs
    //      WHERE product_id = ? AND logged_at > last_distill_at
    //      ORDER BY logged_at
    //
    // 2. Load existing memory index as context
    //    const existingIndex = await store.loadIndex()
    //
    // 3. Side-query to Haiku (cheap, ~$0.001 per distill)
    //    System: DISTILL_PROMPT (instructs model to merge observations into memories)
    //    Input: existing memories + new observations
    //    Output (structured): {
    //      memories: [{
    //        name: string,           // e.g. "subreddit_performance"
    //        description: string,    // one-line for relevance matching
    //        type: MemoryType,
    //        content: string,        // full body
    //        action: 'create' | 'update' | 'delete'
    //      }]
    //    }
    //
    // 4. Apply actions to agent_memories table
    //    create/update → store.saveEntry() (UPSERT by product_id + name)
    //    delete → store.removeEntry()
    //
    // 5. Mark logs as processed (update last_distill_at or soft-delete)
    //    Index auto-rebuilds from DB on next loadIndex()
}
```

**Trigger strategy: BullMQ repeatable + threshold hybrid**

```typescript
// src/workers/index.ts — add dream queue

// 1. Repeatable job: nightly fallback (catches everything)
const dreamQueue = new Queue('dream', { connection: redis })
await dreamQueue.add('distill-all', {}, {
  repeat: { pattern: '0 4 * * *' }  // 4am daily
})

// 2. Threshold trigger: after each discovery/content run
// In discovery.ts / content.ts processors:
const dream = new AgentDream(store)
await dream.logInsight("...")
if (await dream.shouldDistill()) {
  await dreamQueue.add('distill', { productId }, {
    jobId: `distill-${productId}`,  // dedup: one per product
    delay: 60_000,                   // debounce: wait 1 min for batch
  })
}
```

**Why hybrid:**
- Repeatable job = safety net, guarantees daily processing
- Threshold trigger = responsive, high-activity products learn faster (don't wait until 4am)
- `jobId` dedup prevents multiple distill jobs for same product
- `delay` debounce lets multiple agent runs batch their logs before distilling

**Filesystem vs Supabase comparison:**

| | Engine (filesystem) | ShipFlare (Supabase) |
|---|---|---|
| Log write | append to `logs/YYYY-MM-DD.md` | `INSERT INTO agent_memory_logs` |
| Index | `MEMORY.md` file | `SELECT name, description FROM agent_memories` |
| Distill trigger | KAIROS nightly `/dream` skill | BullMQ repeatable + threshold hybrid |
| Distill execution | Same process | Worker process (existing infra) |
| Persistence | Filesystem (ephemeral on Vercel) | PostgreSQL (durable) |

### 3.5 Create `src/memory/prompt-builder.ts`

**Port from `engine/memdir/memdir.ts` `buildMemoryPrompt` (lines 272-316) + `buildMemoryLines` (lines 199-266):**

```typescript
// Inject memory context into agent system prompts
export function buildMemoryPrompt(store: MemoryStore): string

// Load query-relevant memories (lazy, during agent execution)
export async function loadRelevantContext(
  query: string,
  store: MemoryStore,
  signal: AbortSignal,
): Promise<string>
```

### 3.6 Update `src/bridge/memory-bridge.ts`

Extend to combine product context (DB) + agent memory (DB):
- `loadProductContext()` — existing, unchanged
- `loadFullContext(userId, productId)` — new, merges product context + memory index + relevant memories into one system prompt block

---

## Phase 4: MCP Integration

### 4.1 Create `src/mcp/types.ts`

**Port from `engine/services/mcp/types.ts` (simplified):**
- `MCPServerConfig` — name, transport (stdio/sse/http), command, url, env, args
- `MCPConnection` — name, status, tools[], capabilities, cleanup fn
- `MCPToolCall` — serverName, toolName, arguments, result

### 4.2 Create `src/mcp/client.ts`

**Port from `engine/services/mcp/client.ts`:**

Headless MCP client using `@modelcontextprotocol/sdk`:
```typescript
export class MCPClient {
  constructor(config: MCPServerConfig)
  async connect(): Promise<void>
  async disconnect(): Promise<void>
  async listTools(): Promise<ToolDefinition[]>
  async callTool(name: string, args: unknown): Promise<ToolResult>
}
```

**Strip:** React hooks, terminal notifications, batched state updates, channel permissions, VSCode SDK transport
**Keep:** stdio/sse/http transport creation, connection lifecycle, tool schema normalization

### 4.3 Create `src/mcp/manager.ts`

**Port from `engine/services/mcp/MCPConnectionManager.tsx`:**

```typescript
export class MCPManager {
  async connectAll(configs: MCPServerConfig[]): Promise<void>
  async disconnectAll(): Promise<void>
  getAvailableTools(): ToolDefinition[]     // merged from all servers
  registerWithRegistry(registry: ToolRegistry): void
}
```

**Key behavior from engine:**
- Reconnection with exponential backoff (max 5 attempts, 1s→30s)
- Graceful cleanup on shutdown
- Tool namespacing: `mcp__{serverName}__{toolName}`

### 4.4 Create `src/mcp/tool-loader.ts`

**Port deferred loading pattern from engine's `shouldDefer` tool flag:**
```typescript
export function createDeferredTool(server: string, tool: string): ToolDefinition
  // Placeholder that loads schema on first use
  // Reduces startup overhead for servers with many tools
```

### 4.5 Investigate Supabase MCP for agent memory

The `@supabase/mcp-server-supabase` package provides MCP tools for database operations. If integrated:
- Agents could read/write memories directly via `mcp__supabase__query` tool
- Eliminates need for custom `MemoryStore` CRUD code
- Discovery/content agents could query past thread data directly
- **Trade-off:** More LLM tokens per memory operation (tool call overhead) vs. simpler architecture
- **Decision point:** Evaluate cost of MCP tool calls vs. direct DB queries. If agent runs are already multi-turn, the marginal cost is low.

---

## Phase 5: Wiring + Cleanup

### 5.1 Port reusable engine tools (flat format)

Extract core logic from engine tool folders into ShipFlare's flat .ts format. Strip UI.tsx, permissions, terminal rendering — keep only the `execute` logic.

**`src/tools/web-fetch.ts`** — From `engine/tools/WebFetchTool/`

Port `utils.ts` (`getURLMarkdownContent` + `applyPromptToMarkdown`). Core value: fetch any URL → convert to Markdown → optionally summarize with Haiku side-query.

```typescript
export const webFetchTool = buildTool({
  name: 'web_fetch',
  description: 'Fetch content from a URL, convert to markdown, and extract information using a prompt.',
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultSizeChars: 100_000,
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
    prompt: z.string().describe('What to extract from the page content'),
  }),
  async execute(input, context) {
    // Core logic from engine/tools/WebFetchTool/utils.ts:
    // 1. fetch URL → raw HTML
    // 2. HTML → Markdown (via turndown or similar)
    // 3. If content > threshold: side-query to Haiku with prompt to summarize
    // 4. Return { url, result, bytes, code, durationMs }
  },
})
```

**Use cases:** Scrape competitor pages, fetch full Reddit post content, read documentation, analyze product pages.

**`src/tools/web-search.ts`** — From `engine/tools/WebSearchTool/`

Uses Claude API's native `web_search` tool (beta). Core value: agent can search the web beyond Reddit.

```typescript
export const webSearchTool = buildTool({
  name: 'web_search',
  description: 'Search the web for information. Returns search results with titles, URLs, and snippets.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    domains: z.array(z.string()).optional().describe('Limit to these domains'),
  }),
  async execute(input, context) {
    // Uses Anthropic API's native web_search tool support
    // or a web search API (Brave, Serper, etc.)
  },
})
```

**Use cases:** Research product landscape, find competitor mentions, discover non-Reddit communities.

**`src/tools/mcp-call.ts`** — From `engine/tools/MCPTool/`

MCP tool call wrapper. Dynamically invokes any tool from a connected MCP server.

```typescript
export const mcpCallTool = buildTool({
  name: 'mcp_call',
  description: 'Call a tool from a connected MCP server.',
  isConcurrencySafe: true,   // depends on underlying tool
  inputSchema: z.object({
    server: z.string().describe('MCP server name'),
    tool: z.string().describe('Tool name on the server'),
    arguments: z.record(z.unknown()).describe('Tool arguments'),
  }),
  async execute(input, context) {
    const manager = context.get<MCPManager>('mcpManager')
    return manager.callTool(input.server, input.tool, input.arguments)
  },
})
```

**Use cases:** Supabase MCP queries, any future MCP integrations.

**NOT ported (and why):**

| Engine tool | Why skip |
|-------------|---------|
| GrepTool | Searches local filesystem — agents don't edit code |
| FileRead/Write/Edit | File I/O for code editing — not relevant |
| GlobTool | File pattern matching — not relevant |
| BashTool | Shell execution — security risk, not needed |
| AgentTool | Interactive subagent management — replaced by `core/swarm.ts` |
| SkillTool | CLI command system — replaced by agent .md definitions |
| TodoWriteTool | Interactive session tracking — not headless-compatible |

### 5.2 Create `src/tools/registry.ts`

Central registration point:
- Import all built-in tools (reddit-search, reddit-post, reddit-verify, web-fetch, web-search)
- Export singleton `registry` instance
- Export `loadMCPTools()` for dynamic MCP tool registration
- MCP tools registered with namespace prefix: `mcp__{serverName}__{toolName}`

### 5.3 Update `src/bridge/agent-runner.ts`

Thin wrapper: delegate to `core/query-loop.ts`'s `runAgent()`. Keep the public API surface identical so workers/routes don't need major changes beyond import paths.

### 5.4 Update `src/bridge/memory-bridge.ts`

Add `loadFullContext()` that merges DB product context + Supabase-backed agent memory.

### 5.5 Update `src/workers/processors/discovery.ts`

- Import `SwarmCoordinator` from `core/swarm`
- Replace `Promise.all` fan-out with `coordinator.fanOut()`
- Pass `onProgress` for event streaming

### 5.6 Update `src/app/api/scan/route.ts`

- Use `SwarmCoordinator` for parallel discovery
- Use `queryLoop()` generator events → SSE mapping
- Remove inline fan-out logic

### 5.7 Delete absorbed files

- `src/bridge/build-tool.ts` → absorbed into `core/tool-system.ts`
- `src/bridge/types.ts` → merged into `core/types.ts`
- `src/bridge/index.ts` → update re-exports to point to new locations

### 5.8 Re-export compatibility

Add re-exports from old paths to new locations so any remaining imports don't break:
```typescript
// src/bridge/index.ts (temporary)
export { runAgent } from '../core/query-loop'
export type { AgentResult, AgentConfig } from '../core/types'
```

---

## Engine Code Reuse Map

| Engine source | Lines used | Target in src/ |
|---------------|-----------|----------------|
| `engine/query.ts` core loop (248-1409) | ~300 | `core/query-loop.ts` |
| `engine/query.ts` error recovery (1188-1256) | ~70 | `core/query-loop.ts` |
| `engine/services/api/claude.ts` raw streaming + cache | ~120 | `core/api-client.ts` |
| `engine/services/api/withRetry.ts` retry logic | ~100 | `core/api-client.ts` |
| `engine/utils/sideQuery.ts` side query utility | ~60 | `core/api-client.ts` |
| `engine/cost-tracker.ts` usage tracking | ~80 | `core/api-client.ts` |
| `engine/Tool.ts` interface + buildTool | ~150 | `core/tool-system.ts` |
| `engine/StreamingToolExecutor` | ~150 | `core/tool-executor.ts` |
| `engine/toolOrchestration.ts` partitioning | ~80 | `core/tool-executor.ts` |
| `engine/coordinator/coordinatorMode.ts` pattern | ~100 | `core/swarm.ts` |
| `engine/tools/AgentTool/` lifecycle patterns | ~120 | `core/swarm.ts` |
| `engine/memdir/memdir.ts` truncation + prompt building | ~150 | `memory/prompt-builder.ts` (store logic replaced by Supabase) |
| `engine/memdir/findRelevantMemories.ts` | ~100 | `memory/retrieval.ts` |
| `engine/memdir/memoryScan.ts` manifest formatting | ~40 | `memory/retrieval.ts` |
| `engine/memdir/memoryTypes.ts` taxonomy | ~50 | `memory/types.ts` |
| `engine/services/mcp/client.ts` connection | ~150 | `mcp/client.ts` |
| `engine/services/mcp/types.ts` | ~50 | `mcp/types.ts` |
| `engine/services/mcp/MCPConnectionManager` | ~100 | `mcp/manager.ts` |
| `engine/tools/WebFetchTool/utils.ts` fetch + markdown | ~120 | `tools/web-fetch.ts` |
| `engine/tools/WebSearchTool/` search logic | ~60 | `tools/web-search.ts` |
| `engine/tools/MCPTool/` passthrough | ~40 | `tools/mcp-call.ts` |
| **Total** | **~2,280** | **~19 new files** |

---

## Intentionally NOT Migrated

| Engine module | Reason |
|---------------|--------|
| `engine/ink/` (50+ files) | Terminal UI framework — ShipFlare is headless |
| `engine/vim/` | Vim keybindings — terminal only |
| `engine/commands/` (20+ dirs) | CLI slash commands — irrelevant |
| `engine/main.tsx` | CLI entry point — replaced by Next.js |
| `engine/components/` (146 files) | React terminal components — ink-specific |
| `engine/assistant/` | Kairos assistant mode — feature-gated, not needed |
| `engine/upstreamproxy/` | Proxy relay — not needed |
| `engine/history.ts` | Session history persistence — workers are stateless |
| `engine/services/analytics/` | GrowthBook/telemetry — ShipFlare has its own |
| `engine/skills/` | Skill loading system — ShipFlare agents use .md definitions, not skills |
| `engine/services/api/promptCacheBreakDetection.ts` | Cache break detection — over-engineered for headless use |
| Auto-compaction in `query.ts` | Agents are stateless (1-10 turns), context doesn't grow enough |
| Permission system in `Tool.ts` | No interactive user to prompt — all tools pre-authorized |

---

## Risks & Dependencies

1. **`@modelcontextprotocol/sdk`** — MCP phase requires this npm package. Check compatibility with Bun runtime.
2. **Structured output beta** — `output_format: { type: 'json_schema' }` requires beta header. Verify Anthropic SDK version supports it.
3. **Prompt caching** — Requires `cache_control` parameter support. Verify with current Anthropic SDK version.
4. **Memory storage** — ~~Filesystem~~ Resolved: use Supabase/PostgreSQL (already in stack). New `agent_memories` + `agent_memory_logs` tables. Also investigate Supabase MCP for agent-direct DB access.
5. **Worker compatibility** — Workers run as separate Bun processes. Ensure `core/` modules work in both Next.js (Node) and Bun contexts.

---

## Files Modified (existing)

| File | Change |
|------|--------|
| `src/bridge/agent-runner.ts` | Refactor to delegate to `core/query-loop.ts` |
| `src/bridge/memory-bridge.ts` | Add `loadFullContext()` using memory system |
| `src/bridge/index.ts` | Update re-exports |
| `src/workers/processors/discovery.ts` | Use `SwarmCoordinator` instead of `Promise.all` |
| `src/app/api/scan/route.ts` | Use `SwarmCoordinator` + generator events for SSE |
| `src/workers/index.ts` | Add `dream` queue worker |

## Files Created (new)

| File | Purpose |
|------|---------|
| `src/core/types.ts` | Core shared types |
| `src/core/api-client.ts` | Anthropic API wrapper (streaming, cache, retry, cost) |
| `src/core/tool-system.ts` | Tool interface + ToolRegistry |
| `src/core/tool-executor.ts` | Concurrent/serial tool batch execution |
| `src/core/query-loop.ts` | Async generator query loop |
| `src/core/swarm.ts` | Multi-agent coordinator |
| `src/memory/types.ts` | Memory type definitions |
| `src/memory/store.ts` | Supabase-backed memory store |
| `src/memory/retrieval.ts` | Relevance-based memory retrieval |
| `src/memory/dream.ts` | Auto-dream log + nightly distillation |
| `src/memory/prompt-builder.ts` | Memory → system prompt injection |
| `src/mcp/types.ts` | MCP type definitions |
| `src/mcp/client.ts` | Headless MCP client |
| `src/mcp/manager.ts` | MCP connection lifecycle |
| `src/mcp/tool-loader.ts` | Progressive tool loading |
| `src/tools/web-fetch.ts` | URL fetch + markdown conversion (from engine WebFetchTool) |
| `src/tools/web-search.ts` | Web search (from engine WebSearchTool) |
| `src/tools/mcp-call.ts` | MCP tool call wrapper (from engine MCPTool) |
| `src/tools/registry.ts` | Central tool registry |
| `src/lib/db/schema/memories.ts` | agent_memories + agent_memory_logs tables |

## Files Deleted

| File | Reason |
|------|--------|
| `src/bridge/build-tool.ts` | Absorbed into `core/tool-system.ts` |
| `src/bridge/types.ts` | Merged into `core/types.ts` |

## Files Unchanged

- `src/agents/*.md` — all agent definitions
- `src/agents/schemas.ts` — output schemas
- `src/tools/reddit-*.ts` — tool implementations (just register with registry)
- `src/tools/url-scraper.ts`, `src/tools/seo-audit.ts` — standalone utilities
- `src/bridge/load-agent.ts` — markdown agent parser
- `src/lib/**` — all shared infra (db, auth, queue, redis, encryption)
- `src/components/**`, `src/hooks/**`, `src/app/**` (pages/layouts) — frontend unchanged

---

## Verification

### Per-phase checks

1. **Phase 1 (Core):** Run existing discovery worker — same results, same cost tracking. Verify error recovery by testing with intentionally large context.
2. **Phase 2 (Swarm):** Run `/api/scan` with 10 subreddits — verify parallel execution, SSE events stream correctly, concurrency limit respected.
3. **Phase 3 (Memory):** Run discovery twice for same product — second run should have memory context from first. Verify `distill()` produces topic files.
4. **Phase 4 (MCP):** Configure a test MCP server (e.g. filesystem), verify tools appear in registry, agent can call MCP tools.
5. **Phase 5 (Cleanup):** `pnpm tsc --noEmit` passes. No broken imports. All workers start cleanly.

### End-to-end

1. `POST /api/scan` with a product URL → streams SSE events → returns scored threads
2. Discovery worker processes job → query + discovery agents run via swarm → threads saved to DB
3. Content worker generates drafts → drafts stored with correct confidence scores
4. Memory accumulates across runs — verify `agent_memories` table grows for the product, `loadIndex()` returns entries
5. Build passes: `pnpm build` succeeds with no type errors
