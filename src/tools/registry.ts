import { ToolRegistry } from '@/core/tool-system';
import { redditSearchTool } from './reddit-search';
import { redditPostTool } from './reddit-post';
import { redditVerifyTool } from './reddit-verify';
import { redditDiscoverSubsTool } from './reddit-discover-subs';
import { redditGetThreadTool } from './reddit-get-thread';
import { redditGetRulesTool } from './reddit-get-rules';
import { redditHotPostsTool } from './reddit-hot-posts';
import { redditSubmitPostTool } from './reddit-submit-post';
import { generateQueriesTool } from './generate-queries';
import { scoreThreadsTool } from './score-threads';
import { classifyIntentTool } from './classify-intent';
import { hnSearchTool } from './hn-search';
import { hnGetThreadTool } from './hn-get-thread';
import { webSearchTool } from './web-search';
import { xSearchTool } from './x-search';
import { xPostTool } from './x-post';
import { xGetUserTweetsTool } from './x-get-user-tweets';
import { xGetTweetTool } from './x-get-tweet';
import { xGetMentionsTool } from './x-get-mentions';
import { xGetMetricsTool } from './x-get-metrics';
import { xThreadPostTool } from './x-thread-post';
// Phase B domain tools — one file per entity. Each barrel re-exports
// the tool variables; registering them here makes them discoverable by
// AGENT.md `tools: [...]` allowlists via the central registry.
import {
  writeStrategicPathTool,
  queryStrategicPathTool,
} from './StrategicPathTools';
import {
  addPlanItemTool,
  updatePlanItemTool,
  queryPlanItemsTool,
  queryStalledItemsTool,
  queryLastWeekCompletionsTool,
} from './PlanItemTools';
import { queryRecentMilestonesTool } from './MilestoneTools';
import { queryMetricsTool } from './MetricsTools';
import { queryTeamStatusTool } from './TeamTools';
import { draftPostTool } from './DraftingTools';

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
registry.register(xPostTool);
registry.register(xGetUserTweetsTool);
registry.register(xGetTweetTool);
registry.register(xGetMentionsTool);
registry.register(xGetMetricsTool);
registry.register(xThreadPostTool);

// Generic tools
registry.register(generateQueriesTool);
registry.register(scoreThreadsTool);
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

// ---------------------------------------------------------------------------
// Phase E Day 1 drafting tools (spec §9.1 + §11 Phase E). Flat snake_case
// identifiers (`draft_post`); agents opt in via AGENT.md `tools: [...]`.
// Writers (x-writer, reddit-writer) call these to generate + persist body
// text on an existing plan_item — the plan_item row is the source of
// truth for channel + context, the tool is the side-effect gate.
// ---------------------------------------------------------------------------
registry.register(draftPostTool);

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
  sendMessageTool: typeof import('./SendMessageTool').sendMessageTool;
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
