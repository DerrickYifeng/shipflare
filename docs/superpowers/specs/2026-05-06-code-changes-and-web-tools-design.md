# Code-changes tool + Anthropic-native web tools for `generating-strategy`

**Date:** 2026-05-06
**Author:** Yifeng (PM/eng)
**Status:** DRAFT
**Branch:** dev

## Problem

The `generating-strategy` skill currently sets numeric milestones (e.g. "waitlist >= 200") with no grounding in real-world data. Symptom: the strategic path tells a brand-new pre-launch product to hit 70 waitlist signups when industry baselines and the product's actual stage may say otherwise. The model is hallucinating numbers because it has no way to look them up.

Compounding this, the upstream "what shipped recently" signal is misnamed and structurally limited:

1. **Misleading name.** `query_recent_milestones` is the tool exposed to the strategist. It does not query milestones — it reads `code_snapshots.diffSummary`, the last meaningful commit summary detected by the daily-diff cron. "Milestone" in the codebase already means strategic goal (`strategicPath.milestones`), and the name collision invites the model to treat raw commit blurbs as goal records.
2. **Single-row overwrite.** `code_snapshots.productId` is `UNIQUE`. Every daily-diff cron `UPDATE`s the row, so historical commits are lost. "Past 14 days of milestones" is, in practice, "the latest meaningful commit, if any."
3. **Haiku-rejected commits vanish forever.** The daily-diff Haiku filter sets `diffSummary = null` for "non-meaningful" commits and advances `commitSha`, so re-running the strategist later cannot recover those changes.
4. **`source` is always `commit`.** The schema enum allows `'commit' | 'pr' | 'release'`, but only commits are written. Releases and PRs — exactly the events that read as milestone-shaped to a founder — are absent.
5. **No web access.** Even if the strategist wanted to verify a number ("typical waitlist for indie SaaS pre-launch"), no tool exists. It must guess from training-data priors.

The fix is structural: rename the tool to be honest about what it is (raw code changes), give the strategist Claude Code-style web search and web fetch so it can ground its numeric milestones in real data, and stop pretending `code_snapshots` is a milestones table.

## Decision

Three tool changes plus a cron deletion plus a column drop, scoped to one sprint:

1. **Rename and rewrite the code-changes tool.** Replace `query_recent_milestones` with **`query_code_changes`**. New behavior: take `sinceISO` + optional `untilISO`, clone the repo on demand, run `git log --since` + `git diff --stat`, return a list of commits. No DB cache. No Haiku filter. Drop the `pr | release` enum branches that were never implemented — only `kind: 'commit'`.
2. **Add `web_search`.** Wrap Anthropic SDK's native `web_search_20250305` server-tool, mirror engine `WebSearchTool`. Pure description-driven invocation — no mechanical "must search before X" gate.
3. **Add `web_fetch`.** Thin wrapper around the existing `scrapeWebsite()` service in `src/services/web-scraper.ts`. Returns markdown directly, no Haiku extraction. Caller LLM extracts whatever it needs from the markdown itself.
4. **Delete the daily-diff cron.** `scheduleCodeDiff()`, the `isDailyDiff` branches in `processCodeScan`, `fanOutDailyDiff`, and `processDailyDiff` are removed. The repo is cloned on demand by `query_code_changes`, only at weekly-replan time. Onboarding's full-scan path stays.
5. **Drop three `code_snapshots` columns** that the daily-diff cron was the sole writer of: `diffSummary`, `changesDetected`, `lastDiffAt`.

The decision-to-call philosophy mirrors engine `WebSearchTool`: the tool description states the use cases, the model decides when to invoke. No `phase × category` matrix, no "you must search before writing a number" mandate. If observation in production shows the model under-searches, we revisit.

## Premises (agreed during brainstorming)

1. **Two concepts both called "milestone" today.** Strategic goals (`strategicPath.milestones`, LLM-set, forward-looking like "waitlist >= 200") and shipping signals (`recentMilestones`, past commit blurbs). The rename to `query_code_changes` collapses the second into "code changes," eliminating the name collision. Business milestones (waitlist N, first paying customer, PH listing) are out of scope this sprint.
2. **Trust the model.** Engine `WebSearchTool` does not gate invocation on context — it describes the tool's purpose and lets the model decide. We follow this pattern. If empirical under-use becomes a problem, we add guidance in the playbook before adding mechanical gates.
3. **`web_fetch` is intentionally raw.** The engine version uses a small fast model to extract per-prompt. We skip that layer — the calling skill (sonnet-4-6) gets the markdown and extracts itself. Saves a Haiku call per fetch; trades some context budget. The model is told to be selective.
4. **`scrapeWebsite()` already exists** in `src/services/web-scraper.ts`, ported from engine `WebFetchTool`, with full SSRF defenses, same-origin-only redirect handling, 60s timeout, 10MB body cap, 100K markdown cap. `web_fetch` is an ~80-line tool wrapper, not new infrastructure.
5. **`code_snapshots` is no longer a milestones cache.** After this change, the table's only writer is the onboarding full-scan path; its only readers are itself (upsert check) and the `DELETE /api/product/code-snapshot` endpoint. The `techStack` / `fileTree` / `keyFiles` / `scanSummary` / `commitSha` / `repoFullName` / `repoUrl` columns stay (re-deriving them from a fresh clone is expensive); the three diff-related columns drop.
6. **Each tool has one home.** `query_code_changes` is for the **content-planner agent** (used at weekly-replan). `web_search` and `web_fetch` are for the **`generating-strategy` skill** (used at onboarding and phase-change). No cross-pollination this sprint.

## Approaches considered

### A — Strong mandate playbook ("MUST web_search before any numeric milestone") [REJECTED]

Add hard rules in `strategic-path-playbook.md` step 4: model is required to call `web_search` before writing any milestone with a number. Add a fixture test (foundation + saas → must include >= 1 web_search call). Most aggressive at solving the "70 waitlist" failure.

Rejected because (a) it diverges from engine philosophy of trust-the-model, (b) it over-fits the current failure case and grows brittle as new failure modes surface, (c) it creates spec/playbook coupling that's painful to evolve. We can escalate to this if observation shows description-driven guidance is insufficient.

### B — Mechanical phase × category gate [REJECTED]

Add a decision matrix: foundation/audience phases must search; compound/steady use `query_metrics`; category=other must search. Most predictable and testable.

Rejected for the same reason as A plus: edge cases (a launching product that already has 1k waitlist) make the matrix wrong; the matrix grows over time; it's not how engine handles this.

### C — Description-driven, engine-aligned [SELECTED]

Mirror `engine/tools/WebSearchTool/prompt.ts`. Tool description states what it's for ("when you need real-world data beyond your training: industry benchmarks, recent product launches, competitor numbers, current market signals"). Model decides when. Server-side `max_uses: 8` per call. No playbook mandate.

Selected because it's the simplest mirror of a battle-tested pattern, lowest spec/code coupling, and gives us a clean baseline to observe before adding constraints.

### D — On-demand clone every call (`query_code_changes`) vs. append-only `code_changes` table [A SELECTED]

A: every `query_code_changes` call clones the repo and runs `git log --since`. Slow per call, always fresh, no schema migration.

B: new `code_changes` table; daily-diff cron writes per-commit rows; `query_code_changes` reads SQL. Fast queries, full history, requires migration + retention.

A selected for this sprint. The user's stated constraint — "trigger only at weekly-replan" — turns this into one clone per user per week, which is acceptable. B is the right long-term direction if either (1) more callers want code-change visibility, or (2) we want to surface code-change history to users in the UI.

## Architecture

### `query_code_changes` (replaces `query_recent_milestones`)

**Location:** `src/tools/QueryCodeChangesTool/`

**Input:**
```ts
{
  sinceISO: string;          // ISO datetime, required
  untilISO?: string;         // ISO datetime, default: now
}
```

**Output:**
```ts
Array<{
  kind: 'commit';
  sha: string;
  title: string;             // commit subject (first line)
  body: string;              // commit body, truncated to ~600 chars
  atISO: string;             // commit datetime
}>
```

**Behavior:**

1. Read `code_snapshots` for `(userId, productId)` to get `repoFullName`. Fail with `no_repo` if absent.
2. `getGitHubToken(userId)` — fail with `no_github_token` if absent.
3. `cloneRepo(repoFullName, githubToken)` (existing helper in `src/services/code-scanner.ts`).
4. `git log --since={sinceISO} --until={untilISO} --format=%H%x00%aI%x00%s%x00%b%x1e` — single `git` call, NUL-separated record fields, RS-separated records. Cap at 50 commits. Truncate `body` to 600 chars per commit.
5. `cleanupClone()`.
6. Return list. Empty list is success — caller decides what to do.

**Failure modes:**

| Code | When | Tool result |
|---|---|---|
| `no_repo` | `code_snapshots` row missing or `repoFullName` null | `is_error: true`, message |
| `no_github_token` | User disconnected GitHub since onboarding | `is_error: true`, message |
| `clone_failed` | Network / auth / repo deleted | `is_error: true`, includes git's stderr |
| `git_log_failed` | git binary error | `is_error: true` |

The skill's caller (content-planner) is expected to fail soft on `is_error: true` — emit plan_items without the code-change context rather than aborting the replan.

**Concurrency:** `isConcurrencySafe: true`. Each call clones to a unique tmpdir.

### `web_search`

**Location:** `src/tools/WebSearchTool/`

**Input:**
```ts
{
  query: string;                       // min 2 chars
  allowed_domains?: string[];          // optional whitelist
  blocked_domains?: string[];          // optional blacklist (mutually exclusive with allowed_domains)
}
```

**Output:** mirror engine shape:
```ts
{
  query: string;
  results: Array<
    | { tool_use_id: string; content: Array<{ title: string; url: string }> }
    | string  // text commentary from server-side model
  >;
  durationSeconds: number;
}
```

**Implementation:**

Use Anthropic SDK directly, no custom search backend:

```ts
const client = new Anthropic();
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1024,
  system: 'You are an assistant for performing a web search tool use',
  messages: [{ role: 'user', content: `Perform a web search for the query: ${query}` }],
  tools: [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 8,
    allowed_domains: input.allowed_domains,
    blocked_domains: input.blocked_domains,
  }],
});
```

Then iterate the response content blocks, accumulating `web_search_tool_result` arrays into `results` and free-form `text` blocks as commentary strings. Mirror engine's `makeOutputFromSearchResponse`.

**Tool description (the load-bearing prompt for invocation decisions):**

```
- Searches the web and returns up to 10 result links per call
- Use this when you need real-world data beyond your training cutoff: industry
  benchmarks, recent product launches, competitor numbers, market signals
- Especially useful when setting numeric milestones — search for typical
  baselines in this product's category and stage before writing a target
- Returns title + URL for each hit. Use web_fetch to read a specific result
- Up to 8 server-side searches per call; cite sources in your output
- Use the current year in queries when looking for recent data
```

**Failure handling:**

- Anthropic API errors → `is_error: true` with the error message
- `web_search_tool_result.error_code` from server → push the error string into `results[]` (matches engine), tool itself returns `is_error: false`. Caller LLM sees the error and decides whether to retry or skip.

**Read-only / concurrency-safe:** yes / yes.

### `web_fetch`

**Location:** `src/tools/WebFetchTool/`

**Input:**
```ts
{ url: string }
```

**Output:**
```ts
{
  url: string;
  status: 'success' | 'thin_content' | 'not_found' | 'forbidden' | 'redirect' | 'error';
  code: number;              // 0 on transport error
  bytes: number;             // markdown size
  pageMarkdown: string;      // capped at 100K chars
  title: string;
  description: string;
  ogImage: string | null;
  redirectUrl?: string;      // when cross-origin redirect detected
  error?: string;
  durationMs: number;
}
```

**Implementation:** ~80 lines. Call existing `scrapeWebsite(url)` from `src/services/web-scraper.ts`. Translate the `WebScrapeResult` into the tool output shape; add `durationMs`. No new SSRF / redirect / parsing code.

**Tool description:**

```
- Fetches a URL and returns the page content as markdown
- Use to deeply read a specific page (e.g. a result from web_search)
- Markdown is capped at ~100K chars; large pages are truncated
- HTTP is auto-upgraded to HTTPS; redirects only follow same-origin
- If status is 'redirect', the page redirected cross-origin — call web_fetch
  again with the redirectUrl to follow
- Be selective: each fetch consumes context. Prefer searching first to
  identify the right URL, then fetching once
```

**Read-only / concurrency-safe:** yes / yes.

### Daily-diff cron deletion

Remove from `src/workers/index.ts`:

- The `scheduleCodeDiff()` function and its call site
- The `'code-diff-cron'` repeat schedule

Remove from `src/workers/processors/code-scan.ts`:

- `processDailyDiff()` function
- `fanOutDailyDiff()` function
- The `if (isDailyDiff && userId === '__all__')` and `if (isDailyDiff)` branches in `processCodeScan`
- The `isDailyDiff: true` field becomes unused; remove from `CodeScanJobData` in `src/lib/queue/types.ts`

Keep:

- `processCodeScan` full-scan path (onboarding)
- `cloneRepo` / `cleanupClone` / `getCommitSha` / `diffRepo` exports in `src/services/code-scanner.ts` — `diffRepo` is unused after this change but kept for now (could be deleted in a follow-up cleanup PR; not in scope).

Actually `diffRepo` is the only caller of `DIFF_ANALYZE_PROMPT` and the Haiku diff judge — since `diffRepo` becomes orphaned, **also delete `diffRepo` and `DIFF_ANALYZE_PROMPT`** to avoid leaving a dead 60-line function. Update the section's scope below.

### `code_snapshots` migration

Drizzle migration: drop columns `diff_summary`, `changes_detected`, `last_diff_at`. Update `src/lib/db/schema/code-snapshots.ts` accordingly.

The migration is non-breaking: no live readers, no live writers post this PR. Existing data in those columns is discarded (acceptable — the data is at most "yesterday's commit blurb" which has no value past today).

### Skill / agent wiring

**`generating-strategy/SKILL.md`:**

- `allowed-tools`: remove `query_recent_milestones`, `query_metrics`. Add `web_search`, `web_fetch`. (Keep `write_strategic_path` and `query_strategic_path`.)
- Drop `query_metrics` because the strategist doesn't need live metrics — the metrics tool was speculative; it's used in tactical planning, not strategy. Confirm-before-removing: this is per-task verifiable, not load-bearing on this design.
  - **Resolution:** verify in implementation: if anything in the playbook references `query_metrics`, keep it. Otherwise remove. Default: keep, in case (no harm).

**`generating-strategy/schema.ts`:**

- Delete `recentMilestoneSchema`, `milestoneSourceEnum`.
- Delete `recentMilestones` field from `generatingStrategyInputSchema`.
- Delete `voiceProfile` field — it has no source path anywhere (already-known dead field; per CLAUDE.md "refactor freely during v2 migration" rule, this is in scope as a related cleanup since the schema is being touched).
  - **Resolution:** keep `voiceProfile` removal in scope only if it's a single-line drop with no downstream impact. Verify in implementation. Default: remove.

**`generating-strategy/references/strategic-path-playbook.md`:**

- Step 4 ("Set milestones with success metrics"): add one paragraph at the end:
  > Before writing a numeric milestone, consider whether your training-data prior is reliable for this product's category and stage. If you're setting a number ("waitlist >= 200", "MRR >= $500"), use `web_search` to verify against real-world baselines for similar indie products in this stage. If a search hit is promising, use `web_fetch` to read the page directly.
- No mandate, no mechanical rule. The same pattern engine uses.

**`allocating-plan-items/schema.ts`:**

- Rename `signals.recentMilestones` → `signals.recentCodeChanges`. Update the type comment to "`query_code_changes` output — commits in the past N days."

**`allocating-plan-items/SKILL.md` and `references/allocation-rules.md`:**

- Update each `recentMilestones` reference to `recentCodeChanges`. Conceptually identical, just renamed.

**Content-planner agent's `tools:` allow-list:**

- Locate the AGENT.md (likely `src/tools/AgentTool/agents/content-planner/AGENT.md` or similar — confirmed during exploration: `src/tools/AgentTool/agents/coordinator/references/decision-examples.md` references it).
- Add `query_code_changes` to its `tools:` block.
- Remove `query_recent_milestones` if present.

**`src/lib/team/redact-for-client.ts`:**

- Update the tool-name → public-label map: `query_recent_milestones` entry becomes `query_code_changes`. Public label "reading-context" stays appropriate.

**`src/tools/registry-team.ts` (or wherever tools are registered):**

- Register `query_code_changes`, `web_search`, `web_fetch`.
- Unregister `query_recent_milestones`.

## Data flow

### Onboarding (no change to this sprint's tools)

```
User connects GitHub
  → /api/onboarding/repo POST
  → enqueue code-scan job (full scan)
  → processCodeScan: clone, scan, write code_snapshots row
  → /api/onboarding/plan POST
  → SSE → runForkSkill('generating-strategy', {...})
  → skill calls web_search ("indie [category] waitlist baseline pre-launch 2026")
  → skill calls web_fetch on a promising hit (optional)
  → skill calls write_strategic_path
  → StructuredOutput
```

### Phase change (no change to this sprint's tools)

```
User updates state in Settings → POST /api/product/phase
  → updates products row, deactivates old strategic_path
  → enqueue team-run trigger='phase_transition'
  → lead dispatches generating-strategy
  → skill: web_search / web_fetch as needed → write_strategic_path
```

### Weekly replan (this is where query_code_changes runs)

```
Monday 00:00 UTC weekly-replan-cron
  → processWeeklyReplan: per-user runTacticalReplan(userId, 'weekly')
  → enqueues team-run trigger='weekly_replan'
  → coordinator dispatches content-planner agent
  → content-planner calls:
    - query_strategic_path (existing)
    - query_stalled_items (existing)
    - query_last_week_completions (existing)
    - query_recent_x_posts (existing)
    - query_code_changes(sinceISO=last_monday, untilISO=this_monday)  ← NEW
    - dispatches allocating-plan-items skill with signals = { ..., recentCodeChanges }
  → allocating-plan-items writes plan_items via add_plan_item
```

The same agent path applies to manual `/api/plan/replan` (trigger='manual') and the user-initiated path through Settings. `query_code_changes` is invoked once per replan, regardless of trigger.

## Failure handling

| Failure | Behavior |
|---|---|
| `query_code_changes` `no_repo` / `no_github_token` | Tool returns `is_error: true`. content-planner sees it, proceeds with `recentCodeChanges: []`. Replan succeeds. |
| `query_code_changes` `clone_failed` | Same — fail soft, `recentCodeChanges: []`. Log at warn level for ops visibility. |
| `web_search` Anthropic API timeout / error | Tool returns `is_error: true`. generating-strategy proceeds with whatever it knows from training data. The skill must not abort — `web_search` is a supplement, not a hard dependency. |
| `web_fetch` 404 / 403 / network error | Returns success-shaped output with `status: 'error'` and a message. Skill reads the status, may try another URL. |
| `web_fetch` cross-origin redirect | Returns `status: 'redirect'` + `redirectUrl`. Skill chooses to refetch with the new URL or skip. |
| `web_fetch` thin content (<100 chars body) | Returns `status: 'thin_content'` with whatever text was extracted. Skill decides. |
| Onboarding without GitHub connected | Skill input has no `repoFullName` regardless. `query_code_changes` is not invoked at onboarding (per architecture above). No regression. |

## Testing

### Unit tests

- **`QueryCodeChangesTool`:** mock `cloneRepo` / git execFile. Verify (a) `git log` invoked with correct `--since/--until`, (b) commit body truncation at 600 chars, (c) 50-commit cap, (d) error codes wired right.
- **`WebSearchTool`:** mock `Anthropic.messages.create` to return synthesized content blocks; verify `makeOutputFromSearchResponse` parses correctly. Test allowed/blocked domains exclusivity check.
- **`WebFetchTool`:** mock `scrapeWebsite`; verify each `WebScrapeResult.status` maps to the right tool output. Verify `durationMs` is computed.
- **Daily-diff cron deletion:** verify no test still imports `processDailyDiff` / `fanOutDailyDiff`. The existing tests for the full-scan path stay green.
- **Schema migration:** smoke-test the migration runs against a fresh DB and an existing one with data in the dropped columns.

### Integration tests

- **`generating-strategy` with mocked `web_search` / `web_fetch`:** snapshot test — given a synthetic input, verify the skill makes ≥1 `web_search` call when the playbook hint applies. (Soft check; failure should warn, not break, since the spec philosophy is description-driven not mandate.)
- **`content-planner` weekly-replan path:** verify `query_code_changes` is invoked with sane `sinceISO` (last Monday). Use a fixture repo via mocked `cloneRepo`.

### Manual smoke

- Onboarding with a real GitHub repo end-to-end: verify the strategic path mentions a baseline number (anecdotal — we're checking the model's behavior, not asserting it).
- A weekly-replan run on dev: verify content-planner logs `query_code_changes` execution and the resulting plan_items are sane.

## Migration / deploy

1. Drizzle migration drops the three columns. Non-breaking — no live reader.
2. Code change ships as one PR (or two if we want the migration in its own PR for rollback ease).
3. After deploy: the Monday weekly-replan cron triggers the new tool path. If `query_code_changes` errors at scale, content-planner's fail-soft means replans still write plan_items, just without code-change context.
4. Rollback path: revert PR. The dropped columns can be re-added by an inverse migration; in-flight production data lost, which is acceptable.

## Out of scope

- Business milestone subsystem (waitlist count, paying customer count, PH listing). Tracked separately if/when needed.
- Append-only `code_changes` table (Approach D-B above). Revisit if more callers want code-change visibility or if UI surfaces code history.
- Cleanup of dead UI component `src/components/product/code-snapshot-section.tsx` (orphan; nothing imports it).
- `voiceProfile` ingestion path (the field has no DB column, no writer, no UI). Removing the schema field is in scope as part of the schema cleanup; building the ingestion is not.
- Removing speculative `query_metrics` from `generating-strategy` allowed-tools — verify in implementation, default keep.
- Caching `web_search` / `web_fetch` results across users (same-category baseline searches are duplicative; future optimization).

## Open questions

None. The `query_metrics` and `voiceProfile` decisions are explicit "verify in implementation, default X" notes in the relevant sections above — not blockers.

## Risks

1. **Per-user weekly clone cost.** `query_code_changes` clones the repo once per user per weekly-replan. For users with large monorepos, this can run for 30-60 seconds. Mitigation: weekly-replan is async (cron enqueues team-runs and returns), so clone time doesn't block the cron. If abuse appears, escalate to Approach D-B.
2. **`web_search` cost is variable.** Server-side `max_uses: 8` per call, but Anthropic charges per server-side search. A skill that runs `web_search` 3 times across its `maxTurns: 10` could trigger up to 24 server-side searches. Acceptable at current volume; revisit if Anthropic billing shows surprise spikes.
3. **`web_fetch` context bloat.** A 100K-char markdown blob enters the calling skill's context per fetch. Three fetches = 300K chars. The skill's `maxTurns: 10` mostly absorbs this, but pathological fetches could compress prematurely. Mitigation: tool description tells the model to prefer search-then-fetch one URL, not bulk fetching.
4. **Description-driven invocation under-fires.** The model might not call `web_search` even when it should ("70 waitlist out of nowhere" recurs). Mitigation: monitor replan logs after deploy; if under-firing >30% in obvious cases, escalate to playbook mandate (Approach A above).

## References

- Engine `WebSearchTool`: `engine/tools/WebSearchTool/{WebSearchTool.ts,prompt.ts}` — invocation pattern + prompt template
- Engine `WebFetchTool`: `engine/tools/WebFetchTool/` — full reference; we're using the lightweight version
- Existing `scrapeWebsite()` service: `src/services/web-scraper.ts` (already engine-aligned per file comments)
- Existing `query_recent_milestones`: `src/tools/QueryRecentMilestonesTool/QueryRecentMilestonesTool.ts` — being replaced
- Daily-diff cron: `src/workers/index.ts:309` (`scheduleCodeDiff`), `src/workers/processors/code-scan.ts` — being deleted
- `code_snapshots` schema: `src/lib/db/schema/code-snapshots.ts` — losing 3 columns
- Strategic path playbook: `src/skills/generating-strategy/references/strategic-path-playbook.md` — gaining one paragraph
- Allocation rules: `src/skills/allocating-plan-items/{schema.ts,SKILL.md,references/allocation-rules.md}` — field rename
- Anthropic SDK web_search reference: https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool
