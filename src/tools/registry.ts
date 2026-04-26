import { ToolRegistry } from '@/core/tool-system';
import { redditSearchTool } from './RedditSearchTool/RedditSearchTool';
import { redditPostTool } from './RedditPostTool/RedditPostTool';
import { redditVerifyTool } from './RedditVerifyTool/RedditVerifyTool';
import { redditDiscoverSubsTool } from './RedditDiscoverSubsTool/RedditDiscoverSubsTool';
import { redditGetThreadTool } from './RedditGetThreadTool/RedditGetThreadTool';
import { redditGetRulesTool } from './RedditGetRulesTool/RedditGetRulesTool';
import { redditHotPostsTool } from './RedditHotPostsTool/RedditHotPostsTool';
import { redditSubmitPostTool } from './RedditSubmitPostTool/RedditSubmitPostTool';
import { classifyIntentTool } from './ClassifyIntentTool/ClassifyIntentTool';
import { hnSearchTool } from './HnSearchTool/HnSearchTool';
import { hnGetThreadTool } from './HnGetThreadTool/HnGetThreadTool';
import { webSearchTool } from './WebSearchTool/WebSearchTool';
import { xSearchTool } from './XSearchTool/XSearchTool';
import { xSearchBatchTool } from './XSearchTool/XSearchBatchTool';
import { xPostTool } from './XPostTool/XPostTool';
import { xGetUserTweetsTool } from './XGetUserTweetsTool/XGetUserTweetsTool';
import { xGetTweetTool } from './XGetTweetTool/XGetTweetTool';
import { xGetMentionsTool } from './XGetMentionsTool/XGetMentionsTool';
import { xGetMetricsTool } from './XGetMetricsTool/XGetMetricsTool';
// Phase B domain tools — one folder per tool (Claude Code convention).
// Registering them here makes them discoverable by AGENT.md `tools: [...]`
// allowlists via the central registry.
import { writeStrategicPathTool } from './WriteStrategicPathTool/WriteStrategicPathTool';
import { queryStrategicPathTool } from './QueryStrategicPathTool/QueryStrategicPathTool';
import { addPlanItemTool } from './AddPlanItemTool/AddPlanItemTool';
import { updatePlanItemTool } from './UpdatePlanItemTool/UpdatePlanItemTool';
import { queryPlanItemsTool } from './QueryPlanItemsTool/QueryPlanItemsTool';
import { queryStalledItemsTool } from './QueryStalledItemsTool/QueryStalledItemsTool';
import { queryLastWeekCompletionsTool } from './QueryLastWeekCompletionsTool/QueryLastWeekCompletionsTool';
import { queryRecentMilestonesTool } from './QueryRecentMilestonesTool/QueryRecentMilestonesTool';
import { queryMetricsTool } from './QueryMetricsTool/QueryMetricsTool';
import { queryTeamStatusTool } from './QueryTeamStatusTool/QueryTeamStatusTool';
import { queryProductContextTool } from './QueryProductContextTool/QueryProductContextTool';
import { draftPostTool } from './DraftPostTool/DraftPostTool';
import { findThreadsTool } from './FindThreadsTool/FindThreadsTool';
import { draftReplyTool } from './DraftReplyTool/DraftReplyTool';
import { validateDraftTool } from './ValidateDraftTool/ValidateDraftTool';
import { runDiscoveryScanTool } from './RunDiscoveryScanTool/RunDiscoveryScanTool';
import { calibrateSearchStrategyTool } from './CalibrateSearchTool/CalibrateSearchTool';

/**
 * Central tool registry for ShipFlare agents.
 * All built-in tools are registered here. MCP tools can be added
 * dynamically via loadMCPTools().
 */
const registry = new ToolRegistry();

// Reddit tools
registry.register(redditSearchTool);
registry.register(redditPostTool);
registry.register(redditVerifyTool);
registry.register(redditDiscoverSubsTool);
registry.register(redditGetThreadTool);
registry.register(redditGetRulesTool);
registry.register(redditHotPostsTool);
registry.register(redditSubmitPostTool);

// HackerNews tools
registry.register(hnSearchTool);
registry.register(hnGetThreadTool);

// X tools
registry.register(xSearchTool);
registry.register(xSearchBatchTool);
registry.register(xPostTool);
registry.register(xGetUserTweetsTool);
registry.register(xGetTweetTool);
registry.register(xGetMentionsTool);
registry.register(xGetMetricsTool);

// Generic tools
registry.register(classifyIntentTool);
registry.register(webSearchTool);

// ---------------------------------------------------------------------------
// Phase B domain tools (spec §9 + §11 Phase B Day 1-2). Flat snake_case
// identifiers match Claude Code's tool-naming convention. Unlike the
// Task / SendMessage team-runtime tools (which ship from `registry-team.ts`
// to avoid module cycles), the domain tools have no circular imports — they
// read + write scoped DB state only — so they register inline here.
// ---------------------------------------------------------------------------
registry.register(writeStrategicPathTool);
registry.register(queryStrategicPathTool);
registry.register(addPlanItemTool);
registry.register(updatePlanItemTool);
registry.register(queryPlanItemsTool);
registry.register(queryStalledItemsTool);
registry.register(queryLastWeekCompletionsTool);
registry.register(queryRecentMilestonesTool);
registry.register(queryMetricsTool);
registry.register(queryTeamStatusTool);
registry.register(queryProductContextTool);

// ---------------------------------------------------------------------------
// Phase E drafting tools (spec §9.1 + §11 Phase E). Flat snake_case
// identifiers; agents opt in via AGENT.md `tools: [...]`.
//
// Day 1: post-writer calls `draft_post` to generate + persist body text on
// an existing plan_item — the plan_item row is the source of truth for
// channel + context, the tool is the side-effect gate.
//
// Day 2: community-manager calls `find_threads` (read-only inbox scan) +
// `draft_reply` (INSERT drafts with status='pending') for the reply-guy
// workflow. find_threads is concurrency-safe read-only; draft_reply is
// concurrency-safe writes (each draft is its own row).
// ---------------------------------------------------------------------------
registry.register(draftPostTool);
registry.register(findThreadsTool);
registry.register(draftReplyTool);
// validate_draft is the post-draft platform-rule + style verifier. Agents
// call it AFTER writing copy and BEFORE draft_reply / draft_post so platform
// rejections (length, NFC, t.co URL accounting, sibling-platform leak,
// hallucinated stats) never reach the founder's review queue. It's also
// the source of truth for ShipFlare style warnings (hashtag count, links
// in body/reply, anchor token).
registry.register(validateDraftTool);

// ---------------------------------------------------------------------------
// Unified discovery pipeline tools. `run_discovery_scan` wraps
// `runDiscoveryV3` so the coordinator can drive discovery inline from a
// team-run loop. The persist-only `draft_reply` above is the only reply
// tool community-manager needs — it drafts the body in its own LLM turn
// using the prose rules in `community-manager/references/`.
// ---------------------------------------------------------------------------
registry.register(runDiscoveryScanTool);

// `calibrate_search_strategy` is the one-time companion to run_discovery_scan.
// First scan for a (user, product, platform) triggers calibration; subsequent
// scans pull the persisted strategy from MemoryStore. Lives next to
// run_discovery_scan in the registry so the coordinator's allowlist can
// declare them together.
registry.register(calibrateSearchStrategyTool);

export { registry };

/**
 * Register Team runtime tools (Task, SendMessage). These are split out of
 * the top-level registration to avoid a module cycle: `AgentTool/spawn.ts`
 * imports `registry` so its tool resolution can look up by name. Eagerly
 * registering `taskTool` in that same module would make the tool exist
 * before its dependencies finished loading.
 *
 * Callers that need these tools available (the team-run worker + the
 * integration tests) must import `./registry-team` for its side effect.
 * StructuredOutput is intentionally NOT registered — it's synthesized
 * per-agent from the caller's Zod outputSchema inside runAgent
 * (see src/tools/StructuredOutputTool/StructuredOutputTool.ts).
 */
export function registerTeamRuntimeTools(tools: {
  taskTool: typeof import('./AgentTool/AgentTool').taskTool;
  sendMessageTool: typeof import('./SendMessageTool/SendMessageTool').sendMessageTool;
}): void {
  registry.register(tools.taskTool);
  registry.register(tools.sendMessageTool);
}

/**
 * Load MCP tools into the registry from an MCPManager.
 * Call this after MCPManager.connectAll() to make MCP tools
 * available to agents.
 */
export async function loadMCPTools(mcpManager: { registerWithRegistry: (registry: ToolRegistry) => void }): Promise<void> {
  mcpManager.registerWithRegistry(registry);
}
