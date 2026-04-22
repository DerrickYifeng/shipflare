// Side-effect module that registers the team-runtime tools (Task,
// SendMessage) into the central registry. Import this from the team-run
// worker + the integration tests, never from general code.
//
// Splitting the registration out of `registry.ts` prevents a module-init
// cycle: `src/tools/AgentTool/spawn.ts` imports `@/tools/registry` so that
// AGENT.md `tools: [...]` names can resolve to ToolDefinitions, but
// `AgentTool/AgentTool.ts` (which exports `taskTool`) cannot be imported
// at `registry.ts` top level without the module graph re-entering itself
// before any tool definitions are live.
//
// This module is imported AFTER both sides have finished initializing, so
// `taskTool` and `sendMessageTool` are fully constructed before we hand
// them to `registerTeamRuntimeTools`.

import { registerTeamRuntimeTools } from './registry';
import { taskTool } from './AgentTool/AgentTool';
import { sendMessageTool } from './SendMessageTool/SendMessageTool';

registerTeamRuntimeTools({ taskTool, sendMessageTool });
