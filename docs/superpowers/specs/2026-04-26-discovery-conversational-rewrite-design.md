# Discovery Conversational Rewrite

**Date:** 2026-04-26
**Status:** approved (brainstorming complete, awaiting plan)
**Supersedes:** `2026-04-26-kickoff-fast-path-and-tool-progress-design.md` (the calibration / fast-path / tool-progress spec) — all of its discovery-related architecture is replaced wholesale. The tool-progress events that spec introduced **stay** and are reused here.

## Problem

The current discovery system is three Sonnet agents (search-strategist, discovery-scout, discovery-reviewer) plus a calibration tool, plus dual-mode `run_discovery_scan`, plus an entire pipeline of review-gates and disagreement logging. It evolved that shape because xAI Grok was treated as a dumb search API: scout fetched raw tweets, then our own Sonnet judged them, then a second Sonnet shadow-judged for QC.

Three problems with this:

1. **Latency.** A single kickoff scan today takes 3-5 minutes (scout's Sonnet judgment of 25-37 raw tweets ≈ 3 min; discovery-reviewer's second pass on the same threads ≈ 60s). Calibration adds another 10 minutes once per product.
2. **Wasted Sonnet rounds.** discovery-scout uses 1 of its 10 budgeted turns on judgment. discovery-reviewer uses 1 of its 5. Both are essentially one-shot LLM calls wrapped in agent harnesses for no inter-turn benefit.
3. **Grok is an LLM, not a search engine.** Grok's `x_search` tool autonomously searches X based on natural-language instructions, applies filters in-prompt, returns enriched results with author bios + engagement stats. Today we throw that away and re-implement everything outside Grok.

Real-user data confirms this: a 25-thread scan that returned 1 queueable tweet took 3 min 44 s of wall clock, mostly burning Sonnet judgment cycles on tweets a more conversational ask to Grok would have rejected at search time.

## Goals

1. **One agent, conversational with xAI.** Replace the 3-agent + calibration + pipeline stack with a single Sonnet agent that talks to Grok via Grok's native `x_search` tool + JSON `response_format`, refining its instructions across turns until results meet quality.
2. **Pure architectural simplification.** Remove ~1500 LOC, ~6 directories, and the entire calibration / strategy-cache / reviewer-disagreement training apparatus. No backwards-compat shims.
3. **First-class engagement signal.** Persist likes / reposts / replies / views on every thread. Surface in `/today`. Use to rank `/today` order so high-leverage threads land first.
4. **Repost handling done right.** Treat the original tweet as the canonical thread; reposters become evidence (`surfaced_via JSONB`) accumulating across scans.
5. **Dynamic cost escalation.** Default to xAI's fast non-reasoning model. Agent escalates to reasoning model only when initial rounds fail to converge.
6. **End-to-end kickoff scan in ~2-3 minutes** (vs current 5+).

## Non-goals

- Reddit support. v1 is X-only. Existing `reddit_search` tool stays untouched; `discovery-agent` rejects `platform: 'reddit'` for now.
- Reviewer-disagreement training loop. Real user labels in `thread_feedback` are a stronger signal than another LLM second-guessing the first; we use that pipeline as the long-term improvement seam.
- Backwards-compat for the old API surface. `run_discovery_scan` tool is deleted (not gated, not deprecated). Coordinator playbooks switch to `Task({ subagent_type: 'discovery-agent' })`.
- Backfill of engagement stats for legacy `threads` rows. New columns are nullable; old rows render `—` in /today badges. A historical backfill is a separate one-shot if ever needed.

## Architecture

```
coordinator (kickoff / cron playbook)
  └─ Task({ subagent_type: 'discovery-agent', description, prompt })
        └─ discovery-agent (Sonnet, maxTurns 60)
              ├─ xai_find_customers(messages, productContext, reasoning?)   ← 1-N times
              ├─ persist_queue_threads(rows)                                ← end-of-run
              └─ StructuredOutput { queued, scanned, scoutNotes, costUsd }
```

**Three layers, one job each:**

- **Coordinator** dispatches the agent; reads channel preflight from goal preamble (`Connected channels: x | none`).
- **discovery-agent** owns judgment + iteration. Reads product context from prompt; reads `discovery-rubric` from MemoryStore via `<agent-memory>` block. Loops: ask Grok → judge results → refine OR conclude. Persists final list at end.
- **xai_find_customers tool** is stateless. Forwards the agent's full `messages[]` history to Grok plus `tools: [{ type: 'x_search' }]` and `response_format: { type: 'json_schema', strict: true, ... }`. Returns parsed JSON + the new assistant message for the agent to thread back on the next call.
- **persist_queue_threads tool** writes the agent's final list to `threads` with engagement-weighted ordering and repost canonicalization.

## Components

### NEW

- **`src/tools/AgentTool/agents/discovery-agent/AGENT.md`** — frontmatter `model: claude-sonnet-4-6`, `maxTurns: 60`, `tools: [xai_find_customers, persist_queue_threads, StructuredOutput]`, `shared-references: [base-guidelines, judgment-rubric]`. Prompt sections: input contract (product context + intent), workflow (compose first xAI prompt → call → judge → refine → conclude), reasoning-escalation guidance ("default `reasoning: false`; escalate to `true` after 2 weak rounds"), persistence rule ("call `persist_queue_threads` once with the final list; do not call mid-run"), delivery (StructuredOutput shape).
- **`src/tools/AgentTool/agents/discovery-agent/schema.ts`** — `discoveryAgentOutputSchema`:
  ```ts
  z.object({
    queued: z.number().int().min(0),
    scanned: z.number().int().min(0),
    scoutNotes: z.string(),
    costUsd: z.number().min(0),
    /** Top N threads (sorted by engagement-weighted score) for the
     *  coordinator to pass directly to community-manager without a
     *  second DB round-trip. Full rows are already persisted via
     *  persist_queue_threads; this is the lightweight handoff payload. */
    topQueued: z.array(z.object({
      externalId: z.string(),
      url: z.string().url(),
      authorUsername: z.string(),
      body: z.string(),
      likesCount: z.number().int().nullable(),
      repostsCount: z.number().int().nullable(),
      confidence: z.number().min(0).max(1),
    })).max(10),
  })
  ```
  Coordinator's playbook reads `topQueued.slice(0, 3)` from the agent's StructuredOutput and embeds in the community-manager Task prompt.
- **`src/tools/XaiFindCustomersTool/XaiFindCustomersTool.ts`** — stateless tool.
  ```ts
  inputSchema: z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1),
    })).min(1),
    productContext: z.object({
      name: z.string(),
      description: z.string(),
      valueProp: z.string().nullable(),
      targetAudience: z.string().nullable(),
      keywords: z.array(z.string()),
    }),
    /** When true, xAI uses the reasoning-enabled model variant
     *  (slower, ~2-5x cost, deeper analysis). Agent escalates to true
     *  when initial rounds return weak results. Default false. */
    reasoning: z.boolean().default(false),
  })
  ```
  Tweet result shape (returned in `tweets[]`):
  ```ts
  {
    external_id: string,         // canonical = original id when is_repost
    url: string,                  // canonical url
    author_username: string,      // reply target (original author when repost)
    author_bio: string | null,
    author_followers: number | null,
    body: string,
    posted_at: string,            // ISO 8601
    likes_count: number | null,
    reposts_count: number | null,
    replies_count: number | null,
    views_count: number | null,
    is_repost: boolean,
    original_url: string | null,           // null when !is_repost
    original_author_username: string | null,
    surfaced_via: string[] | null,         // reposter handles when is_repost
    confidence: number,           // 0-1, Grok's confidence
    reason: string,               // 1 sentence, product-specific
  }
  ```
  Tool output: `{ assistantMessage: { role, content }, tweets: Tweet[], notes: string, costUsd: number }`. Agent appends `assistantMessage` to its tracked history before the next call.

  **xAI integration details:**
  - Default model: `XAI_MODEL_FAST` env var (initial value: `grok-4-fast` or current non-reasoning Grok 4 variant)
  - Reasoning model: `XAI_MODEL_REASONING` env var (initial value: `grok-4.20-reasoning`)
  - `response_format: { type: 'json_schema', json_schema: { name: 'CustomerTweets', schema: ..., strict: true } }`
  - `tools: [{ type: 'x_search' }]`
  - JSON-schema construction via `toXaiJsonSchema(zodSchema)` helper that: (a) sets `additionalProperties: false` on every object, (b) coerces nullables to type arrays (`{"type": ["string", "null"]}`), (c) avoids array-form `items` and other xAI-rejected shapes (per [xAI structured outputs docs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs))
  - On HTTP error: throws (no swallow). Agent decides retry policy.
  - On schema-validation failure of xAI's response: throws with `schema-construction-bug` prefix — indicates we've built an unsupported schema, not runtime variance. xAI guarantees match for supported features; a parse failure means our toolside bug.

- **`src/tools/PersistQueueThreadsTool/PersistQueueThreadsTool.ts`** — DB-write tool.
  ```ts
  inputSchema: z.object({
    threads: z.array(/* same Tweet shape as xai_find_customers, minus surfaced_via if not relevant */).max(50),
  })
  ```
  Internals:
  1. Validate input (zod)
  2. Compute `engagementScore = confidence * Math.log10(1 + (likes ?? 0) + 5 * (reposts ?? 0))` per row
  3. Sort rows by `engagementScore` descending
  4. For each row: `INSERT INTO threads (...) VALUES (...) ON CONFLICT (user_id, platform, external_id) DO NOTHING` (dedup on canonical id)
  5. For repost rows where the dedup branch hit (existing row): `UPDATE threads SET surfaced_via = jsonb_strip_duplicates(COALESCE(surfaced_via, '[]'::jsonb) || $newReposters::jsonb) WHERE ...` to merge new reposters
  6. Return `{ inserted: number, deduped: number }`

- **DB migration: `migrations/<next-sequential-number>_threads_engagement_and_repost.sql`** (numeric prefix matches the next free slot when implementing) — adds nullable columns to `threads`:
  - `likes_count INT`, `reposts_count INT`, `replies_count INT`, `views_count INT`
  - `is_repost BOOLEAN NOT NULL DEFAULT FALSE`
  - `original_url TEXT`, `original_author_username TEXT`
  - `surfaced_via JSONB`

- **`src/tools/XaiFindCustomersTool/__tests__/XaiFindCustomersTool.test.ts`** + **`src/tools/PersistQueueThreadsTool/__tests__/PersistQueueThreadsTool.test.ts`** — see Testing section.

- **`src/tools/AgentTool/agents/discovery-agent/__tests__/`** — smoke + integration tests.

### MODIFIED

- **`src/lib/xai-client.ts`** — adds `respondConversational(args)` method:
  ```ts
  async respondConversational(args: {
    messages: Array<{ role, content }>,
    tools?: Array<{ type: 'x_search' | 'web_search' }>,
    responseFormat?: { type: 'json_schema', json_schema: ... },
    model: string,             // resolved by caller from XAI_MODEL_* env
    signal?: AbortSignal,
  }): Promise<{ output: unknown, assistantMessage: { role, content }, usage: { costUsd: number } }>
  ```
  Deletes `searchTweetsBatch`, `SEARCH_TWEETS_BATCH_MAX_QUERIES`, the bio-batch helpers — Grok's native `x_search` tool returns enriched authors directly. Keeps `getCachedClient()`, API-key handling, the bio enrichment that's now redundant.

- **`src/lib/db/schema/[threads-file]`** — add column declarations matching the migration (Drizzle).

- **`src/tools/registry.ts`** — registers `xai_find_customers`, `persist_queue_threads`. Removes registrations for `run_discovery_scan`, `calibrate_search_strategy`, `x_search_batch`, `x_search`.

- **`src/tools/AgentTool/agents/coordinator/AGENT.md`** — kickoff playbook becomes:
  > **Step 1.** Task content-planner.
  > **Step 2.** If X is connected: `Task({ subagent_type: 'discovery-agent', description: '...', prompt: '...' })`.
  > **Step 3.** If step 2 returned `queued > 0`: Task community-manager on top-3 from the persisted threads.
  > Skip steps 2-3 if no channels are connected.

  Cron playbook becomes:
  > For each connected platform that has an active discovery use-case (X for v1): `Task({ subagent_type: 'discovery-agent', ... })`. If queued > 0, dispatch community-manager.

  Deletes: the entire calibration + re-scan choreography. Deletes the `strategy_not_calibrated` recovery branch (already gone in earlier work, but coordinator copy needs final cleanup).

- **`src/lib/team-kickoff.ts`** — goal text rewritten:
  ```
  First-visit kickoff for ${productName}.
  weekStart=${kickoffWeekStart} now=${kickoffNow.toISOString()}.
  Connected channels: ${channels.join(', ') || 'none'}.
  Trigger: kickoff.
  Follow your kickoff playbook end-to-end (plan → discover → drafts):
  (1) Task content-planner for week-1 plan items — pass weekStart + now in its prompt verbatim.
  (2) Task discovery-agent (subagent_type: 'discovery-agent') to find X reply targets.
  (3) Task community-manager on the top-3 queued threads from step 2.
  Skip steps 2-3 if no channels are connected.
  ```

- **`src/lib/__tests__/team-kickoff.test.ts`** — assertions updated:
  - Goal contains `Task` + `discovery-agent`
  - Goal does NOT contain `run_discovery_scan`, `calibrate_search_strategy`, `inlineQueryCount`
  - Order: content-planner string appears before discovery-agent string, which appears before community-manager string

- **`src/app/(app)/today/_components/reply-card.tsx`** (or wherever the reply card lives) — engagement badge ("128 likes · 12 reposts · 4 replies"), `surfaced_via` chips when non-empty.

- **`src/components/today/tactical-progress-card.tsx`** — no code change. Existing `tool_progress` consumer routes events from `xai_find_customers` and `persist_queue_threads` automatically. Calibration row is now dead code; remove the calibration-specific case in the reducer + UI rendering since calibration no longer exists. ActivityTicker handles any unknown tool name including the new ones.

- **`src/app/api/today/progress/route.ts`** — calibration platforms always returns `[]` (no calibration concept anymore). Cleanup the corresponding code path. Tests updated.

### DELETED — entire directories or files

- `src/tools/RunDiscoveryScanTool/` (entire directory + tests)
- `src/tools/CalibrateSearchTool/` (entire directory: `CalibrateSearchTool.ts`, `strategy-memory.ts`, `report-progress-tool-name.ts`, tests)
- `src/tools/XSearchTool/` (entire directory: `XSearchBatchTool.ts`, single-query `XSearchTool.ts`, tests) — replaced by `xai_find_customers`. Verify at delete time: scout was the only `x_search_batch` consumer via `v3-pipeline`, but if any other tool/agent ends up referencing them, drop those references in the same commit (tsc will surface).
- `src/tools/AgentTool/agents/discovery-scout/` (entire directory + tests + schema + references)
- `src/tools/AgentTool/agents/discovery-reviewer/` (entire directory + tests + schema + references)
- `src/tools/AgentTool/agents/search-strategist/` (entire directory + tests + schema + references)
- `src/lib/discovery/v3-pipeline.ts` + tests
- `src/lib/discovery/persist-scout-verdicts.ts` + tests (replaced by `PersistQueueThreadsTool`)
- `src/lib/discovery/review-gate.ts` + tests
- `src/lib/discovery/reviewer-disagreements.ts` + tests
- The `spawn.ts` carve-out for `report_progress` — REPORT_PROGRESS_TOOL_NAME no longer needs to be whitelisted because no agent declares it
- The corresponding entries in `registry.ts` and `registry-team.ts` if any

### KEPT, no changes

- **`generateOnboardingRubric` and `onboarding-rubric.ts`** — still fires once at signup, still writes `discovery-rubric` to MemoryStore. discovery-agent reads it via `<agent-memory>` block.
- **`src/lib/sse/publish-tool-progress.ts`** — agent emits via `ctx.emitProgress`.
- **The team-run worker's `emitProgress` lambda + `tool_progress` mirroring to `team_messages`** — kept verbatim. The new tools (`xai_find_customers`, `persist_queue_threads`) emit through it the same way old tools did.
- **`reddit_search` tool** — untouched. Reddit support is deferred; the tool stays in the registry until Reddit gets its own design.

## Data flow (end-to-end)

| T | Event | Surface |
|---|---|---|
| 0s | User clicks Commit in onboarding | wizard |
| 0-2s | `POST /api/onboarding/commit` writes products / strategic_paths / plans; fires `generateOnboardingRubric` (one-shot Sonnet, ~5s, $0.015) → MemoryStore `discovery-rubric` | server |
| 2-5s | `/team` SSR calls `ensureKickoffEnqueued`; team-run enqueued with new goal text | /team |
| 5-60s | Step 1: content-planner runs, writes ~10 plan_items | /team chat + /today TacticalSection |
| 60-90s | Step 2: coordinator dispatches `Task({ subagent_type: 'discovery-agent' })` | /team chat dispatch card |
| 90-180s | discovery-agent loop: 1-N calls to `xai_find_customers`, possibly with `reasoning: true` escalation after 2 weak rounds. Tools emit `tool_progress` events automatically — `xai_find_customers` emits "Asking Grok (fast) for ICP-matching tweets…" and "Got 14 candidates · 8 above threshold" before/after each call (and "(reasoning)" suffix when the tool was called with `reasoning: true`); `persist_queue_threads` emits "Persisting 7 threads" before its DB write. The agent itself does not emit narrative progress — its reasoning is visible only via the tool-emitted events around its decisions. | /team chat inline progress lines + /today ActivityTicker |
| 180-200s | Agent calls `persist_queue_threads(7 final keepers)`; tool sorts by engagement-weighted score, INSERT ON CONFLICT DO NOTHING, returns `{ inserted: 7, deduped: 0 }` | /today reply cards land |
| 200-220s | Agent emits StructuredOutput; coordinator dispatches Task community-manager on top-3 | /team chat |
| 220-260s | community-manager drafts 3 replies via `draft_reply` tool | /today reply card bodies populate |

**Total: ~3-4 minutes** end-to-end vs current ~5-15 minutes. Discovery slice is **~3-5× faster** than the current scout+reviewer+(maybe calibration) stack.

## Error handling & edge cases

| Failure | Behavior |
|---|---|
| xAI returns 0 tweets | Agent decides per round: first call → broaden constraints + retry. After 2-3 broadening attempts with 0 results → call `persist_queue_threads({ threads: [] })` and emit StructuredOutput with `queued: 0` and informative scoutNotes ("Searched X with 4 ICP variants, found nothing relevant"). /today shows EmptyState quoting scoutNotes. |
| xAI returns malformed JSON / fails strict-schema match | Indicates we built an unsupported schema (xAI guarantees match for supported features per docs). Tool throws with `schema-construction-bug` prefix; agent's tool_result carries the error; agent gives up immediately and emits StructuredOutput with degraded notes. **No silent retries** — this is a programming bug, not runtime variance. |
| xAI HTTP error / 5xx / rate limit | Tool throws verbatim. Agent retries the same call once. Second failure → emit StructuredOutput with degraded notes "xAI rate limit / outage; will retry next cron". team-run flagged degraded but not failed. |
| No X channel connected | Coordinator's playbook check fires before the Task — kickoff goal already says `Connected channels: x | none`. If no X, coordinator skips step 2 entirely with the "Connect X" message. discovery-agent never spawned. |
| Agent hits maxTurns (60) without calling persist_queue_threads | Treated as a budget-exhausted failure. The runAgent harness throws when an agent exits without StructuredOutput. team-run worker logs failure; conversation shows "discovery-agent ran out of turns". Should be vanishingly rare with the budget. |
| Agent calls persist_queue_threads twice | Allowed. Same dedup logic applies. Each call's `inserted` / `deduped` counts are accurate; agent's StructuredOutput.queued is the agent's own bookkeeping. |
| Repost where original tweet's external_id already exists in threads | INSERT ON CONFLICT DO NOTHING wins; UPDATE merges new reposter handles into `surfaced_via`. /today reply card shows accumulated reposter chip count. |
| Repost where original_author_username is null (deleted/private original) | Row is unreplyable → agent should drop from persist list (instructed in AGENT.md) and mention in scoutNotes. Persist tool itself doesn't second-guess. |
| Concurrent kickoff (double-tab) | `ensureKickoffEnqueued` is idempotent on `(teamId, trigger='kickoff')` — unchanged. Second tab observes the same in-flight team-run. |
| User leaves /today during discovery | SSE pubsub doesn't replay live events; on return, `/api/today/progress` snapshot reseeds tactical state, and `team_messages` history loads on /team replay (this morning's mirroring work). /today's progress card shows latest tactical/discovery row state from snapshot. |
| `discovery-rubric` missing from MemoryStore (e.g., race on first scan after signup) | Agent's `<agent-memory>` block has no `discovery-rubric` entry. Agent's system prompt has fallback language: "if no ICP rubric in memory, derive ICP from product fields directly and mention the derivation in scoutNotes". Scan still works; results are slightly less specific. Next scan with the now-present rubric is sharper. |
| Migration on existing dev DB | All new columns nullable. Legacy threads rows have NULL for engagement + repost columns. `/today` UI handles NULL gracefully (omits badge or shows `—`). No backfill required. |

## Testing strategy

### Unit tests (vitest)

**`XaiFindCustomersTool.test.ts`**
- Forwards `messages` array verbatim to `xaiClient.respondConversational`
- Maps `reasoning: false` → `XAI_MODEL_FAST`, `reasoning: true` → `XAI_MODEL_REASONING`
- Sets `response_format.type = 'json_schema'` with `strict: true` and the constructed schema
- Sets `tools: [{ type: 'x_search' }]`
- Returns parsed `tweets[]` + raw `assistantMessage` for the agent to thread back
- HTTP error → throws (no swallow); test asserts the error surfaces unchanged
- Schema-construction-bug error → throws with prefix
- `toXaiJsonSchema(zodSchema)` helper unit tests: (a) `additionalProperties: false` on every object, (b) nullables become type arrays, (c) no array-form items

**`PersistQueueThreadsTool.test.ts`**
- Fresh insert: 5 rows in → 5 rows persisted, `inserted: 5, deduped: 0`
- Dedup: same external_id called twice → second call `inserted: 0, deduped: 5`
- Repost merge across two scans: row exists with `surfaced_via: ['@a']`; second persist with `surfaced_via: ['@b']` → row has `['@a', '@b']` (deduplicated)
- Engagement-weighted ordering: input in arbitrary order → DB inserts in `confidence * log10(1 + likes + 5*reposts)` desc order
- Schema validation: missing required field is rejected by zod

**`discovery-agent` schema test** — validates `discoveryAgentOutputSchema` accepts the documented shape, rejects malformed.

**`team-kickoff.test.ts`** — assertions updated:
- Goal contains `Task` and `discovery-agent`
- Goal does NOT contain `run_discovery_scan`, `calibrate_search_strategy`, `inlineQueryCount`
- Order: content-planner Task string appears before discovery-agent Task string, which appears before community-manager Task string
- "Skip steps 2-3 if no channels are connected" string preserved (verbatim)

### Integration tests (vitest with mocked xAI)

**`discovery-agent.integration.test.ts`** (new)
- Happy path: mock xAI returns 8 strong tweets on first call → agent calls `persist_queue_threads` once → emits StructuredOutput with `queued: 8`
- Refinement path: mock xAI returns 4 strong + 6 junk on call 1; agent issues refinement → mock returns 6 strong on call 2 → persist with 10 final → StructuredOutput
- Reasoning escalation: mock xAI returns 2 weak results across 2 rounds → assert agent's third call has `reasoning: true`
- 0-result path: mock xAI returns `tweets: []` on every call → agent calls `persist_queue_threads({ threads: [] })` and StructuredOutput with `queued: 0`
- HTTP error path: mock xAI throws on call 2 → agent's tool_result carries the error; agent retries once; second failure → degraded StructuredOutput

### Build gate

- `pnpm tsc --noEmit` clean. Deletion of scout/reviewer/strategist/calibrate touches the agent registry + a few imports across the codebase; build green is proof of no dangling references.
- `pnpm vitest run` green for all in-scope tests. The discovery-scout loader-smoke test goes away with the agent; the post-writer loader-smoke test (pre-existing failure unrelated to discovery) stays.

### Manual verification

1. Reset local dev DB + Redis (`TRUNCATE products, plans, plan_items, threads, strategic_paths, team_runs, team_messages, automation_conversations RESTART IDENTITY CASCADE`; `redis-cli FLUSHDB`).
2. Run onboarding end-to-end with X connected.
3. On `/team`: chief-of-staff dispatches `Task discovery-agent` after content-planner. **No** `run_discovery_scan`, **no** `calibrate_search_strategy` in the chat.
4. discovery-agent's dispatch card shows inline `tool_progress` lines: "Asking Grok for ICP-matching tweets…", possibly "Refining xAI search · excluding 4 patterns", possibly "Escalating to reasoning mode after 2 weak rounds", final "Persisting 7 threads".
5. Switch to `/today` within ~3 minutes: reply cards render with engagement badges ("128 likes · 12 reposts") and reposter chips when applicable.
6. Approve / skip a card to verify the existing approve/skip flow works against the new threads schema.

### Migration verification

- Apply migration on a fresh DB: succeeds.
- Apply migration on a dev DB with existing legacy threads rows: succeeds, all new columns NULL on legacy rows.
- After a new-pipeline scan, `SELECT likes_count, is_repost, surfaced_via FROM threads ORDER BY created_at DESC LIMIT 1`: populated.

## Backwards compatibility

None. Per project rule: this design **deletes** the old behavior rather than gating it.

- `RunDiscoveryScanTool` — deleted (entire directory).
- `CalibrateSearchTool` + `strategy-memory` + `report-progress-tool-name` — deleted (entire directory).
- `XSearchTool` (single + batch) — deleted (entire directory).
- `discovery-scout`, `discovery-reviewer`, `search-strategist` agents — deleted (entire directories).
- `v3-pipeline`, `persist-scout-verdicts`, `review-gate`, `reviewer-disagreements` — deleted.
- `report_progress` carve-out in `spawn.ts` — deleted (no agent declares it now).
- Coordinator playbook calibration / re-scan choreography — deleted, replaced.
- Tests asserting any of the above — deleted, not adapted.

The single supersede edge case: the spec `2026-04-26-kickoff-fast-path-and-tool-progress-design.md` keeps a marker pointing here; its `tool_progress` events + team_messages mirroring infrastructure stays (this design relies on it).

## Follow-ups (not in this design)

- Reddit pipeline. Same A2A pattern applied to Reddit — but there's no Grok-equivalent for Reddit. Either: (a) wrap `reddit_search` + a Haiku judge in a sister tool, (b) use a multi-platform Grok call once xAI exposes Reddit data, (c) defer until Reddit becomes a primary channel for any user.
- Engagement ranking calibration. The `confidence * log10(1 + likes + 5*reposts)` formula is a guess. After 2-3 weeks of real founder approve/skip data we can fit a better weighting (or learn it from feedback).
- `/today` filter chip for "≥10 likes" / "≥1 repost" — small UI add once the engagement signal proves useful in practice.
- Real-user-feedback distill pipeline. The dream-distill job that read `agent_memory_logs` (reviewer disagreements) needs to be repointed at `thread_feedback` (founder approve/skip actions) as its primary signal source. Out of scope here; tracked separately.

## Open questions

None blocking. Implementation plan can proceed.
