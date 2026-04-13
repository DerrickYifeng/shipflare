// Bridge layer: re-exports from core/ modules.
// Maintains backward compatibility for existing imports.

export { buildTool, toAnthropicTool } from '../core/tool-system';
export { runAgent, createToolContext } from '../core/query-loop';
export { loadAgentFromFile, loadAgentsFromDir, parseAgentMarkdown } from './load-agent';
export type {
  ToolDefinition,
  ToolContext,
  AgentConfig,
  AgentResult,
} from '../core/types';
export { MODEL_PRICING } from '../core/types';
export { loadProductContext } from './memory-bridge';
