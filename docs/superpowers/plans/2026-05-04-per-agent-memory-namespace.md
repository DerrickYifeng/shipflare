# Per-Agent Memory Namespace (Stub Plan — Argues Against)

> **Stub plan** — scoped intent. Status: **P3 (I argue against)**. Roadmap row #8.
> Override with: "expand per-agent memory plan; ignore my objection."

## Goal (if we did this)

Split `agent_memories` table from today's `(userId, productId)` scope to `(userId, productId, agentDefName)` so each agent has its own memory namespace — coordinator's learnings don't leak into social-media-manager's `<agent-memory>` injection and vice versa. Mirrors engine's `engine/tools/AgentTool/agentMemory.ts` per-agent lifecycle.

## Why I argue against

1. **Cross-agent product knowledge is the asset.** Coordinator observing "humble voice landed for outage threads" and social-media-manager learning "humble voice landed for outage threads" should be ONE entry, not two. Per-agent split fragments learning and forces duplication.
2. **Today's 2-agent shape doesn't justify it.** Coordinator and social-media-manager work on the same brand voice, same audience, same channels. The natural overlap is high. Per-agent split would mostly produce identical entries with slightly different framing.
3. **Engine's per-agent split exists because engine agents are personas with distinct authority** (a `code-reviewer` agent shouldn't see a `growth-strategist` agent's learnings — they're different domains). Our agents are all in the marketing org; they share a brand.
4. **If we ever genuinely need scoped memory** (e.g. PMM should not see SEO's learnings about competitor backlinks), add a `scope: 'shared' | 'self'` column then — additive, doesn't break shared default.

## What the plan would look like (if greenlit)

### Architecture

1. Migration: add `agent_def_name` text column to `agent_memories` (nullable; null = shared, the default). Backfill existing rows with NULL to preserve current behavior.
2. `MemoryStore` constructor extended with optional `agentDefName: string | null` arg. When set, `loadIndex()` and `loadEntry()` filter to `(userId, productId, agentDefName) OR (userId, productId, NULL)` (self entries + shared entries).
3. `read_memory` and `write_memory_log` tools read `currentMemberId` from ctx, look up `agentDefName` for that member, pass to MemoryStore. Both shared and self entries are visible to read; new logs default to `agentDefName` of the writer.
4. AGENT.md update: when an agent calls `write_memory_log`, the log is namespaced to that agent unless explicitly `scope: 'shared'`.

### File map

- Create: `drizzle/0022_agent_memories_namespace.sql`
- Modify: `src/memory/store.ts` — add agentDefName to constructor, filter accordingly
- Modify: `src/tools/ReadMemoryTool/ReadMemoryTool.ts` — read agentDefName from ctx
- Modify: `src/tools/WriteMemoryLogTool/WriteMemoryLogTool.ts` — read agentDefName from ctx, accept optional `scope` arg
- Modify: both AGENT.mds — note the scoping rule

### Tasks (high-level)

1. Migration with backfill.
2. MemoryStore filter logic update.
3. Tool wiring (both read + write).
4. AGENT.md updates documenting scope behavior.
5. Tests covering: shared visible to all, self visible only to owner.

## Tradeoffs / risks (assuming we do it)

- **Backfill ambiguity.** Existing entries become "shared" by default — that may not match what the founder intended for entries written before scoping existed. No clean fix; document and move on.
- **Agents have to think about scope when logging.** Today: "I learned X, log it." After: "I learned X — is this for me, or for everyone?" Cognitive overhead with limited payoff at 2-agent scale.
- **Distill pipeline must be scope-aware.** Currently distills `(userId, productId)`-grouped logs into one `agent_memories` index. After: distill twice (once per scope) or carry scope through the distillation. Adds complexity.
- **You will likely regret it within 3 months** as the same lesson gets logged twice (once by each agent) and the founder asks "why are these duplicate?".

## My recommendation

**Don't do this.** Today's shared scope is the right shape for marketing-org agents. If a future agent (SEO Manager) genuinely needs scoped memory, add the `scope` column then as an additive change. The migration is cheap; the cognitive cost is the issue.

## If you override

- Confirm by saying: "expand per-agent memory plan; I want it scoped per-agent."
- I'll generate the bite-sized TDD plan. Estimate: 3–4 days.
