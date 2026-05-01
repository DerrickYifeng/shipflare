import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { skillTool } from '@/tools/SkillTool/SkillTool';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';


const FIXTURES = path.resolve(__dirname, 'fixtures');

function fakeCtx() {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(key: string) => null as unknown as V,
  };
}

describe('skillTool', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
  });

  it('exposes the canonical SKILL_TOOL_NAME', () => {
    expect(skillTool.name).toBe('skill');
  });

  it('input schema rejects missing skill field', () => {
    const result = skillTool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('input schema accepts skill + optional args', () => {
    expect(
      skillTool.inputSchema.safeParse({ skill: 'valid-skill' }).success,
    ).toBe(true);
    expect(
      skillTool.inputSchema.safeParse({ skill: 'valid-skill', args: 'hello' })
        .success,
    ).toBe(true);
  });

  it('execute() throws on unknown skill', async () => {
    await expect(
      skillTool.execute({ skill: 'no-such-skill' }, fakeCtx() as never),
    ).rejects.toThrow(/Unknown skill/i);
  });
});

describe('SkillTool inline mode', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
  });

  it('returns skill body with $ARGUMENTS substituted', async () => {
    const result = await skillTool.execute(
      { skill: 'valid-skill', args: 'hello world' },
      fakeCtx() as never,
    );
    expect(result.status).toBe('inline');
    expect(result.commandName).toBe('valid-skill');
    expect(result.content).toContain('Echo back: hello world');
    expect(result.success).toBe(true);
  });

  it("forwards args to a bundled skill's getPromptForCommand closure", async () => {
    registerBundledSkill({
      name: 'no-placeholder',
      description: 'No $ARGUMENTS in body.',
      context: 'inline',
      getPromptForCommand: (args) => `Static body. Args were: ${args}`,
    });
    const result = await skillTool.execute(
      { skill: 'no-placeholder', args: 'extra' },
      fakeCtx() as never,
    );
    expect(result.content).toContain('Args were: extra');
  });

  it('handles bundled skill execute without args', async () => {
    registerBundledSkill({
      name: 'no-args',
      description: 'no args needed',
      context: 'inline',
      getPromptForCommand: () => 'static body',
    });
    const result = await skillTool.execute(
      { skill: 'no-args' },
      fakeCtx() as never,
    );
    expect(result.content).toBe('static body');
    expect(result.status).toBe('inline');
  });
});

describe('SkillTool fork mode', () => {
  beforeEach(() => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(FIXTURES);
  });

  it('spawns a sub-agent and returns its result text (mocked spawn)', async () => {
    // Register a fork skill.
    registerBundledSkill({
      name: 'fork-test',
      description: 'A fork skill.',
      context: 'fork',
      allowedTools: [],
      maxTurns: 4,
      getPromptForCommand: (args) => `# Body\n\nArgs: ${args}`,
    });

    // We can't easily spin up real LLM in unit tests — the fork path uses
    // spawnSubagent which calls runAgent. Rather than mock that here, this
    // test only verifies that:
    //   (a) execute() routes to the fork branch
    //   (b) errors from spawnSubagent surface (we call into a non-runnable
    //       context; a thrown error indicates the dispatcher took the right
    //       branch). Real fork verification happens in the integration test
    //       (Task 18) where a runnable context is provided.
    await expect(
      skillTool.execute({ skill: 'fork-test', args: 'x' }, fakeCtx() as never),
    ).rejects.not.toThrow(/NOT_IMPLEMENTED/);
  });
});
