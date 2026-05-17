import { describe, it, expect } from 'vitest';
import { safeAgentChain, MAX_AGENT_DEPTH, AgentDepthExceededError, AgentCycleError } from '../src/lib/agent-depth';

describe('safeAgentChain', () => {
  it('allows up to MAX_AGENT_DEPTH', () => {
    const ctx: any = { props: {} };
    for (let i = 0; i < MAX_AGENT_DEPTH; i++) {
      safeAgentChain.check(ctx, `Agent${i}`);
    }
    expect(ctx.props.__agentChain.length).toBe(MAX_AGENT_DEPTH);
  });

  it('throws AgentDepthExceededError beyond MAX_AGENT_DEPTH', () => {
    const ctx: any = { props: { __agentChain: ['A', 'B', 'C'] } };
    expect(() => safeAgentChain.check(ctx, 'D')).toThrow(AgentDepthExceededError);
  });

  it('throws AgentCycleError on repeated class in chain', () => {
    const ctx: any = { props: { __agentChain: ['CMO', 'HoG'] } };
    expect(() => safeAgentChain.check(ctx, 'CMO')).toThrow(AgentCycleError);
  });

  it('does not mutate input chain (returns a new array)', () => {
    const original = ['CMO'];
    const ctx: any = { props: { __agentChain: original } };
    safeAgentChain.check(ctx, 'HoG');
    expect(original).toEqual(['CMO']);
    expect(ctx.props.__agentChain).toEqual(['CMO', 'HoG']);
  });
});
