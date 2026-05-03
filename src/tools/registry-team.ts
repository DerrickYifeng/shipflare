// Side-effect module that registers the deferred tools (Task,
// SendMessage, Skill — the latter dispatching skill primitives, plus
// Phase C TaskStop) into the central registry. Import this from the
// team-run worker + the integration tests, never from general code.
//
// Splitting the registration out of `registry.ts` prevents a module-init
// cycle: `src/tools/AgentTool/spawn.ts` imports `@/tools/registry` so that
// AGENT.md `tools: [...]` names can resolve to ToolDefinitions, but
// `AgentTool/AgentTool.ts` (which exports `taskTool`), the SendMessage
// tool, `SkillTool/SkillTool.ts` (which transitively reaches
// `AgentTool/spawn` to launch skill subagents), and TaskStopTool (which
// imports `@/workers/processors/lib/wake` → `@/lib/queue/agent-run` and
// is also referenced from `AgentTool/blacklists.ts`) all close the same
// loop — none can be imported at `registry.ts` top level without the
// module graph re-entering itself before any tool definitions are live.
//
// This module is imported AFTER all sides have finished initializing, so
// `taskTool`, `sendMessageTool`, `skillTool`, and `taskStopTool` are
// fully constructed before we hand them to `registerDeferredTools`.

import { registerDeferredTools } from './registry';
import { taskTool } from './AgentTool/AgentTool';
import { sendMessageTool } from './SendMessageTool/SendMessageTool';
import { skillTool } from './SkillTool/SkillTool';
import { taskStopTool } from './TaskStopTool/TaskStopTool';

registerDeferredTools({ taskTool, sendMessageTool, skillTool, taskStopTool });
