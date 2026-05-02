import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';
import { runForkSkill } from '../run-fork-skill';
import type { ToolContext } from '@/core/types';

// Hoisted mock so spawnSubagent never spins up a real LLM. We just want
// to inspect what ctx is passed through.
const spawnSubagentMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/AgentTool/spawn', async () => {
  const actual = await vi.importActual<typeof import('@/tools/AgentTool/spawn')>(
    '@/tools/AgentTool/spawn',
  );
  return {
    ...actual,
    spawnSubagent: spawnSubagentMock,
  };
});

describe('runForkSkill', () => {
  let tmpRoot: string;

  beforeEach(() => {
    __resetRegistryForTesting();
    spawnSubagentMock.mockReset();
    tmpRoot = mkdtempSync(join(tmpdir(), 'shipflare-fork-skill-'));
    __setSkillsRootForTesting(tmpRoot);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetRegistryForTesting();
  });

  it('throws when the skill is not registered', async () => {
    await expect(runForkSkill('does-not-exist', 'hello')).rejects.toThrow(
      /Unknown skill/,
    );
  });

  it('throws when the skill is inline-mode', async () => {
    const dir = join(tmpRoot, 'echo-inline');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: echo-inline
description: test
context: inline
---
body`,
    );

    await expect(runForkSkill('echo-inline', 'hi')).rejects.toThrow(
      /not fork-mode/,
    );
  });

  describe('ctx propagation (regression — without this, skill tools throw "missing required dependency userId")', () => {
    function makeForkSkill(name: string) {
      const dir = join(tmpRoot, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---
name: ${name}
description: test
context: fork
---
body`,
      );
    }

    function makeFakeCtx(deps: Record<string, unknown>): ToolContext {
      return {
        abortSignal: new AbortController().signal,
        get<V>(key: string): V {
          if (key in deps) return deps[key] as V;
          throw new Error(`missing key ${key}`);
        },
      } as ToolContext;
    }

    it('passes a parent ToolContext straight through to spawnSubagent (tool-wrapper path)', async () => {
      makeForkSkill('ctx-passthrough');
      spawnSubagentMock.mockResolvedValueOnce({
        result: 'ok',
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      const parentCtx = makeFakeCtx({
        userId: 'user-1',
        productId: 'prod-1',
      });

      await runForkSkill('ctx-passthrough', 'args', undefined, parentCtx);

      expect(spawnSubagentMock).toHaveBeenCalledTimes(1);
      const ctxArg = spawnSubagentMock.mock.calls[0]?.[2] as ToolContext;
      expect(ctxArg).toBe(parentCtx); // same identity
      // And keys are reachable through the proxy
      expect(ctxArg.get('userId')).toBe('user-1');
      expect(ctxArg.get('productId')).toBe('prod-1');
    });

    it('creates a fresh ctx with the supplied deps (worker path)', async () => {
      makeForkSkill('worker-deps');
      spawnSubagentMock.mockResolvedValueOnce({
        result: 'ok',
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      await runForkSkill('worker-deps', 'args', undefined, {
        userId: 'user-2',
        productId: 'prod-2',
      });

      expect(spawnSubagentMock).toHaveBeenCalledTimes(1);
      const ctxArg = spawnSubagentMock.mock.calls[0]?.[2] as ToolContext;
      // Different identity (fresh ctx), but the deps are reachable via .get
      expect(ctxArg.get('userId')).toBe('user-2');
      expect(ctxArg.get('productId')).toBe('prod-2');
    });
  });
});
