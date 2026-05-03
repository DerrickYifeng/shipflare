// Test helper — produce a complete `BuiltInAgentDefinition` with sensible
// defaults so vi.mock factories don't drift when new fields land in
// loader.ts. Phase A added `disallowedTools`, `background`, `role`,
// `requires`, and `source`; this helper is the single owner of the
// "what does a default-shaped agent definition look like" knowledge for
// the worker test suite.

import type { BuiltInAgentDefinition } from '@/tools/AgentTool/loader';

export function makeMockAgentDefinition(
  over: Partial<BuiltInAgentDefinition> = {},
): BuiltInAgentDefinition {
  return {
    source: 'built-in',
    sourcePath: '/test/AGENT.md',
    name: 'mock-agent',
    description: 'mock agent for tests',
    role: 'member',
    tools: [],
    disallowedTools: [],
    skills: [],
    requires: [],
    background: false,
    maxTurns: 10,
    systemPrompt: '',
    ...over,
  };
}
