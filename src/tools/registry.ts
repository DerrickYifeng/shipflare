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

export { registry };

/**
 * Load MCP tools into the registry from an MCPManager.
 * Call this after MCPManager.connectAll() to make MCP tools
 * available to agents.
 */
export async function loadMCPTools(mcpManager: { registerWithRegistry: (registry: ToolRegistry) => void }): Promise<void> {
  mcpManager.registerWithRegistry(registry);
}
