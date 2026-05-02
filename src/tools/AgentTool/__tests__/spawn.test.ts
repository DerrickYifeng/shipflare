import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

// Mock runAgent so spawnSubagent doesn't actually call the LLM. Capture the
// `prebuilt` argument so we can assert skill preload messages were injected.
const runAgentMock = vi.fn();
vi.mock('@/core/query-loop', () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

// The mocked runAgent resolves to a minimal AgentResult.
runAgentMock.mockResolvedValue({
  result: 'ok',
  cost: 0,
  duration: 0,
  turns: 0,
});

import { spawnSubagent } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';

const FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  'SkillTool',
  '__tests__',
  'fixtures',
);

function fakeCtx() {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  };
}

describe('spawnSubagent skill preload', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
    runAgentMock.mockClear();
  });

  it('injects declared skills into prebuilt.forkContextMessages', async () => {
    registerBundledSkill({
      name: 'preload-me',
      description: 'a skill to preload',
      context: 'inline',
      getPromptForCommand: () => 'PRELOADED CONTENT FROM SKILL',
    });

    const def: AgentDefinition = {
      name: 'caller-agent',
      description: 'parent',
      tools: [],
      disallowedTools: [],
      background: false,
      role: 'member',
      skills: ['preload-me'],
      maxTurns: 5,
      systemPrompt: 'You are an agent.',
      sourcePath: '/test/fake/AGENT.md',
    };

    await spawnSubagent(def, 'do the thing', fakeCtx() as never);

    // Inspect runAgent's invocation.
    const callArgs = runAgentMock.mock.calls[0];
    // signature: (config, userMessage, context, outputSchema, onProgress, prebuilt, ...)
    const prebuilt = callArgs[5];
    expect(prebuilt).toBeDefined();
    expect(prebuilt.forkContextMessages).toBeDefined();
    expect(prebuilt.forkContextMessages.length).toBe(1);
    const content = prebuilt.forkContextMessages[0].content;
    const contentStr =
      typeof content === 'string'
        ? content
        : content.map((b: { text?: string }) => b.text ?? '').join('');
    expect(contentStr).toContain('PRELOADED CONTENT FROM SKILL');
  });

  it('passes no prebuilt when agent declares no skills', async () => {
    const def: AgentDefinition = {
      name: 'no-skills-agent',
      description: 'parent',
      tools: [],
      disallowedTools: [],
      background: false,
      role: 'member',
      skills: [],
      maxTurns: 5,
      systemPrompt: 'You are an agent.',
      sourcePath: '/test/fake/AGENT.md',
    };

    await spawnSubagent(def, 'do the thing', fakeCtx() as never);

    const callArgs = runAgentMock.mock.calls[0];
    const prebuilt = callArgs[5];
    expect(prebuilt).toBeUndefined();
  });

  it('logs warning when a declared skill is not registered', async () => {
    const def: AgentDefinition = {
      name: 'missing-skill-agent',
      description: 'parent',
      tools: [],
      disallowedTools: [],
      background: false,
      role: 'member',
      skills: ['no-such-skill'],
      maxTurns: 5,
      systemPrompt: 'You are an agent.',
      sourcePath: '/test/fake/AGENT.md',
    };

    await expect(
      spawnSubagent(def, 'do the thing', fakeCtx() as never),
    ).resolves.toBeDefined();

    const callArgs = runAgentMock.mock.calls[0];
    const prebuilt = callArgs[5];
    expect(prebuilt).toBeUndefined();
  });
});
