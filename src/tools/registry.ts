import { ToolRegistry } from '@/core/tool-system';
import { redditSearchTool } from './RedditSearchTool/RedditSearchTool';
import { redditPostTool } from './RedditPostTool/RedditPostTool';
import { redditVerifyTool } from './RedditVerifyTool/RedditVerifyTool';
import { redditSubmitPostTool } from './RedditSubmitPostTool/RedditSubmitPostTool';
import { xPostTool } from './XPostTool/XPostTool';
import { xaiFindCustomersTool } from './XaiFindCustomersTool/XaiFindCustomersTool';
import { persistQueueThreadsTool } from './PersistQueueThreadsTool/PersistQueueThreadsTool';
import { xGetTweetTool } from './XGetTweetTool/XGetTweetTool';
import { xGetMentionsTool } from './XGetMentionsTool/XGetMentionsTool';
// Phase B domain tools — one folder per tool (Claude Code convention).
// Registering them here makes them discoverable by AGENT.md `tools: [...]`
// allowlists via the central registry.
import { writeStrategicPathTool } from './WriteStrategicPathTool/WriteStrategicPathTool';
import { generateStrategicPathTool } from './GenerateStrategicPathTool/GenerateStrategicPathTool';
import { readMemoryTool } from './ReadMemoryTool/ReadMemoryTool';
import { queryStrategicPathTool } from './QueryStrategicPathTool/QueryStrategicPathTool';
import { addPlanItemTool } from './AddPlanItemTool/AddPlanItemTool';
import { updatePlanItemTool } from './UpdatePlanItemTool/UpdatePlanItemTool';
import { queryPlanItemsTool } from './QueryPlanItemsTool/QueryPlanItemsTool';
import { queryStalledItemsTool } from './QueryStalledItemsTool/QueryStalledItemsTool';
import { queryLastWeekCompletionsTool } from './QueryLastWeekCompletionsTool/QueryLastWeekCompletionsTool';
import { queryRecentMilestonesTool } from './QueryRecentMilestonesTool/QueryRecentMilestonesTool';
import { queryRecentXPostsTool } from './QueryRecentXPostsTool/QueryRecentXPostsTool';
import { queryMetricsTool } from './QueryMetricsTool/QueryMetricsTool';
import { queryTeamStatusTool } from './QueryTeamStatusTool/QueryTeamStatusTool';
import { queryProductContextTool } from './QueryProductContextTool/QueryProductContextTool';
import { draftPostTool } from './DraftPostTool/DraftPostTool';
import { findThreadsTool } from './FindThreadsTool/FindThreadsTool';
import { draftReplyTool } from './DraftReplyTool/DraftReplyTool';
import { validateDraftTool } from './ValidateDraftTool/ValidateDraftTool';

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
registry.register(redditSubmitPostTool);

// X tools
registry.register(xPostTool);
registry.register(xaiFindCustomersTool);
registry.register(persistQueueThreadsTool);
registry.register(xGetTweetTool);
registry.register(xGetMentionsTool);

// ---------------------------------------------------------------------------
// Phase B domain tools (spec §9 + §11 Phase B Day 1-2). Flat snake_case
// identifiers match Claude Code's tool-naming convention. Unlike the
// Task / SendMessage team-runtime tools (which ship from `registry-team.ts`
// to avoid module cycles), the domain tools have no circular imports — they
// read + write scoped DB state only — so they register inline here.
// ---------------------------------------------------------------------------
registry.register(writeStrategicPathTool);
registry.register(generateStrategicPathTool);
registry.register(readMemoryTool);
registry.register(queryStrategicPathTool);
registry.register(addPlanItemTool);
registry.register(updatePlanItemTool);
registry.register(queryPlanItemsTool);
registry.register(queryStalledItemsTool);
registry.register(queryLastWeekCompletionsTool);
registry.register(queryRecentMilestonesTool);
registry.register(queryRecentXPostsTool);
registry.register(queryMetricsTool);
registry.register(queryTeamStatusTool);
registry.register(queryProductContextTool);

// ---------------------------------------------------------------------------
// Phase E drafting tools (spec §9.1 + §11 Phase E). Flat snake_case
// identifiers; agents opt in via AGENT.md `tools: [...]`.
//
// Day 1: content-manager calls `draft_post` (in post_batch mode) to
// persist body text on an existing plan_item — the plan_item row is the
// source of truth for channel + context, the tool is the side-effect
// gate. Pre-Phase-J the caller was the now-retired post-writer agent.
//
// Day 2: content-manager calls `find_threads` (read-only inbox scan) +
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

export { registry };

/**
 * Register Team runtime tools (Task, SendMessage, Skill). These are split
 * out of the top-level registration to avoid a module cycle:
 * `AgentTool/spawn.ts` imports `registry` so its tool resolution can look
 * up by name. Eagerly registering `taskTool` (or `skillTool`, which itself
 * imports `spawnSubagent`) in that same module would make the tool exist
 * before its dependencies finished loading.
 *
 * Callers that need these tools available (the team-run worker + the
 * integration tests) must import `./registry-team` for its side effect.
 * StructuredOutput is intentionally NOT registered — it's synthesized
 * per-agent from the caller's Zod outputSchema inside runAgent
 * (see src/tools/StructuredOutputTool/StructuredOutputTool.ts).
 *
 * Skill primitive — see src/skills/ + src/tools/SkillTool/.
 * Agents that want skill access add `skill` to their AGENT.md tools: list.
 */
export function registerDeferredTools(tools: {
  taskTool: typeof import('./AgentTool/AgentTool').taskTool;
  sendMessageTool: typeof import('./SendMessageTool/SendMessageTool').sendMessageTool;
  skillTool: typeof import('./SkillTool/SkillTool').skillTool;
}): void {
  registry.register(tools.taskTool);
  registry.register(tools.sendMessageTool);
  registry.register(tools.skillTool);
}

/**
 * Load MCP tools into the registry from an MCPManager.
 * Call this after MCPManager.connectAll() to make MCP tools
 * available to agents.
 */
export async function loadMCPTools(mcpManager: { registerWithRegistry: (registry: ToolRegistry) => void }): Promise<void> {
  mcpManager.registerWithRegistry(registry);
}
