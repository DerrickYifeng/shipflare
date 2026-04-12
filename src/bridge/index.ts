// Bridge layer: adapts Claude Code engine patterns for ShipFlare's headless agents.
// See engine/ for the full infrastructure this is derived from.

export { buildTool, toAnthropicTool } from './build-tool';
export { runAgent, createToolContext } from './agent-runner';
export { loadAgentFromFile, loadAgentsFromDir, parseAgentMarkdown } from './load-agent';
export type {
  ToolDefinition,
  ToolContext,
  AgentConfig,
  AgentResult,
} from './types';
export { MODEL_PRICING } from './types';
export { loadProductContext } from './memory-bridge';
