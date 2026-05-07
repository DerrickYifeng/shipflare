# SkillTool Dynamic 1% Context Budget (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out skilltool-dynamic-budget plan" to expand into bite-sized TDD steps.
> Status: P2 (do later). Roadmap row #12.

## Goal

Match engine's behavior: `SkillTool` advertises available skills via a **dynamically-sized** listing capped at ~1% of the agent's context window (~8k chars at 200k window). Today, our `SkillTool` lists skills by reading the static `_catalog.ts` — every skill always shown regardless of relevance, with no length cap.

Becomes important once we have >25 skills (today: 8). Until then, the static listing is fine.

## Architecture

1. **Reuse engine's algorithm** from `engine/tools/SkillTool/prompt.ts`:
   - `getCharBudget(contextWindowTokens)` returns `floor(contextWindowTokens * CHARS_PER_TOKEN * 0.01)`.
   - Try full descriptions first; if over budget, truncate per-entry to a min length; if still over, drop lowest-priority skills.
2. **No "relevance ranking" in v1.** Engine ships order-by-source (bundled / project / plugin); copy that. Add a `priority: int` field to skill catalog entries when we ship more than 25 skills and need ranking.
3. **Tool description rebuilt per-call** based on current context window from the executing model. The model's max context is read from the agent's effective `model:` config.
4. **Test mode for budget overrides**: `SHIPFLARE_SKILL_LISTING_BUDGET=4000` env var for repro.

## File map

**Modified**
- `src/tools/SkillTool/SkillTool.ts` — replace static description with `buildSkillToolDescription(skills, contextWindowTokens)`
- `src/tools/SkillTool/prompt.ts` (new file) — port `getCharBudget`, `formatCommandDescription`, `formatCommandsWithinBudget` from engine
- `src/skills/_catalog.ts` — add optional `priority?: number` field to entries (default 50; lower = higher priority)
- `src/tools/SkillTool/__tests__/budget.test.ts` — new tests covering budget truncation
- `CLAUDE.md` — note budget rule

## Tasks (high-level)

1. Port engine's `getCharBudget` + budget-truncation logic verbatim (it's pure functions; ~80 lines).
2. Wire into `SkillTool.description()` — read context window from agent ctx, pass to budget fn.
3. Add `priority` field to `_catalog.ts` (no-op in v1 since all skills are 50).
4. Tests: budget under, exactly at, over (with truncation), over (with drop).
5. Manual check: with 8 skills the listing should be unchanged. Verify byte length of tool description didn't grow > original.

## Tradeoffs / risks

- **Premature optimization at 8 skills.** The whole point of this plan is "do later." Building it now adds code without changing observed behavior.
- **Truncation hides skills.** If the founder ships skill #26 and it gets dropped from the listing, agents can't find it. Mitigation: log truncation events to surface "you're hitting the budget; rank skills."
- **Cache invalidation.** Tool description changes per call → tools-block prompt cache busts. Mitigation: cache the description per `(modelName, skillCatalogVersion)` tuple in memory; only rebuild on catalog change.

## Estimate

1–2 days. Tiny — port + test + wire.

## When to flesh out

When `_catalog.ts` exceeds 25 entries OR when prompt-cache analytics show the SkillTool description is a top-3 cache buster. Today, neither is true.
