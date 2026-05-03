import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/core/tool-system';
import {
  assembleToolPool,
  getInjectionTextNames,
} from '@/tools/AgentTool/assemble-tool-pool';
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '@/tools/AgentTool/loader';
import type { AnyToolDefinition } from '@/core/types';

function fakeTool(name: string): AnyToolDefinition {
  return { name } as unknown as AnyToolDefinition;
}

function fakeAgent(
  over: Partial<BuiltInAgentDefinition> = {},
): AgentDefinition {
  return {
    source: 'built-in',
    sourcePath: '/test/AGENT.md',
    name: 'fake',
    description: 'fake agent',
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

describe('assembleToolPool — SSOT four-layer filter', () => {
  it('layer ④: respects AgentDefinition.tools allow-list', () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    reg.register(fakeTool('C'));
    const def = fakeAgent({ tools: ['A', 'C'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['A', 'C']);
  });

  it('layer ④: respects AgentDefinition.disallowedTools subtraction', () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    const def = fakeAgent({ tools: ['A', 'B'], disallowedTools: ['B'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name)).toEqual(['A']);
  });

  it("layer ③: applies INTERNAL_TEAMMATE_TOOLS blacklist for role='member'", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('Task'));
    reg.register(fakeTool('SendMessage'));
    const def = fakeAgent({ tools: ['Task', 'SendMessage'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name)).toEqual(['SendMessage']);
  });

  it('layer ③: lead is unblacklisted — keeps Task', () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('Task'));
    reg.register(fakeTool('SendMessage'));
    const def = fakeAgent({ role: 'lead', tools: ['Task', 'SendMessage'] });
    const pool = assembleToolPool('lead', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['SendMessage', 'Task']);
  });

  it("AgentDefinition.tools='*' lets every-non-blacklisted tool through", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    reg.register(fakeTool('Task'));
    // Spec uses tools: ['*'] (a literal array containing '*') as the
    // sentinel for "all tools allowed". The implementation must accept
    // both the type-safe '*' literal AND ['*'] array form.
    const def = fakeAgent({ tools: ['*'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['A', 'B']); // Task blacklisted
  });

  it('AgentDefinition.tools=["*", ...other] short-circuits to allow-all', () => {
    // Mixed-array form: any '*' in the array means "allow all".
    // Prior implementation (length === 1 only) would silently filter
    // unspecified tools — now the wildcard short-circuits regardless.
    const reg = new ToolRegistry();
    reg.register(fakeTool('A'));
    reg.register(fakeTool('B'));
    reg.register(fakeTool('C'));
    const def = fakeAgent({ tools: ['*', 'A'] });
    const pool = assembleToolPool('member', def, reg);
    expect(pool.map((t) => t.name).sort()).toEqual(['A', 'B', 'C']);
  });

  it('SSOT property: getInjectionTextNames(role, def) === pool tool names', () => {
    // The user-context injection text the team-lead sees about its
    // teammates' tools must equal the actual runtime filter result —
    // engine PDF §3.5.1 invariant ("the spec text is computed from the
    // same constants as the runtime filter, so they cannot drift").
    const reg = new ToolRegistry();
    reg.register(fakeTool('Task'));
    reg.register(fakeTool('SendMessage'));
    reg.register(fakeTool('query_plan_items'));
    const def = fakeAgent({
      tools: ['Task', 'SendMessage', 'query_plan_items'],
      role: 'member',
    });
    const pool = assembleToolPool('member', def, reg);
    const injected = getInjectionTextNames('member', def, reg);
    expect(injected).toEqual(pool.map((t) => t.name).sort());
  });
});
