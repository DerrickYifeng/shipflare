import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';
import { runForkSkill } from '../run-fork-skill';
import type { StreamEvent, ToolContext } from '@/core/types';

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

// resolveSpecialistMemberId touches the DB; mock it to null so the
// non-team-scoped fallback path runs in tests. wrapOnEventWithSpawnMeta
// is left as the real implementation so we can assert the spawnMeta it
// injects.
const resolveSpecialistMemberIdMock = vi.hoisted(() =>
  vi.fn(async () => null),
);
vi.mock('@/tools/AgentTool/AgentTool', async () => {
  const actual = await vi.importActual<
    typeof import('@/tools/AgentTool/AgentTool')
  >('@/tools/AgentTool/AgentTool');
  return {
    ...actual,
    resolveSpecialistMemberId: resolveSpecialistMemberIdMock,
  };
});

describe('runForkSkill', () => {
  let tmpRoot: string;

  beforeEach(() => {
    __resetRegistryForTesting();
    spawnSubagentMock.mockReset();
    resolveSpecialistMemberIdMock.mockReset();
    resolveSpecialistMemberIdMock.mockResolvedValue(null);
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

  describe('spawnMeta wrapping (regression — without this, fork-skill events attribute to the lead in the UI)', () => {
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

    it('wraps onEvent so child tool_done events carry spawnMeta.agentName=skill_<name>', async () => {
      makeForkSkill('judging-thread-quality');
      spawnSubagentMock.mockResolvedValueOnce({
        result: { keep: true },
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      const captured: StreamEvent[] = [];
      const parentOnEvent = (ev: StreamEvent) => {
        captured.push(ev);
      };

      const parentCtx = makeFakeCtx({
        userId: 'user-1',
        productId: 'prod-1',
        onEvent: parentOnEvent,
        toolUseId: 'tool_use_xyz',
      });

      await runForkSkill(
        'judging-thread-quality',
        'args',
        undefined,
        parentCtx,
      );

      // Pull the wrapped onEvent that runForkSkill handed to spawnSubagent.
      const callbacks = spawnSubagentMock.mock.calls[0]?.[3] as
        | { onEvent?: (ev: StreamEvent) => void }
        | undefined;
      expect(callbacks).toBeDefined();
      expect(typeof callbacks?.onEvent).toBe('function');

      // Emit a fake tool_done event through the wrapper — the wrap
      // should inject spawnMeta with agentName = `skill_<name>`.
      const fakeToolDone: StreamEvent = {
        type: 'tool_done',
        toolName: 'StructuredOutput',
        toolUseId: 'inner_tool_use_abc',
        result: { ok: true } as unknown as StreamEvent extends {
          result: infer R;
        }
          ? R
          : never,
        durationMs: 5,
      };
      await callbacks!.onEvent!(fakeToolDone);

      expect(captured.length).toBe(1);
      const ev = captured[0]!;
      expect(ev.type).toBe('tool_done');
      // The conversation-reducer's belongsToSubagent check needs
      // agentName !== 'coordinator' OR a non-empty parentToolUseId.
      // Both should be present here.
      if (ev.type !== 'tool_done') throw new Error('unexpected event shape');
      expect(ev.spawnMeta).toBeDefined();
      expect(ev.spawnMeta!.agentName).toBe('skill_judging-thread-quality');
      expect(ev.spawnMeta!.parentToolUseId).toBe('tool_use_xyz');
      expect(ev.spawnMeta!.parentTaskId).toBeNull();
      // resolveSpecialistMemberId returned null in this test (mocked).
      expect(ev.spawnMeta!.fromMemberId).toBeNull();
    });

    it('falls back to empty parentToolUseId when ctx has no toolUseId', async () => {
      makeForkSkill('some-skill');
      spawnSubagentMock.mockResolvedValueOnce({
        result: 'ok',
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      const captured: StreamEvent[] = [];
      const parentCtx = makeFakeCtx({
        userId: 'u',
        productId: 'p',
        onEvent: (ev: StreamEvent) => {
          captured.push(ev);
        },
        // no toolUseId
      });

      await runForkSkill('some-skill', 'args', undefined, parentCtx);

      const callbacks = spawnSubagentMock.mock.calls[0]?.[3] as
        | { onEvent?: (ev: StreamEvent) => void }
        | undefined;
      const fake: StreamEvent = {
        type: 'tool_start',
        toolName: 'X',
        toolUseId: 'u1',
        input: {},
      };
      await callbacks!.onEvent!(fake);

      const ev = captured[0]!;
      if (ev.type !== 'tool_start') throw new Error('unexpected event shape');
      expect(ev.spawnMeta!.agentName).toBe('skill_some-skill');
      expect(ev.spawnMeta!.parentToolUseId).toBe('');
    });

    it('passes no callbacks to spawnSubagent when parent ctx has no onEvent', async () => {
      makeForkSkill('quiet-skill');
      spawnSubagentMock.mockResolvedValueOnce({
        result: 'ok',
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      const parentCtx = makeFakeCtx({ userId: 'u', productId: 'p' });
      await runForkSkill('quiet-skill', 'args', undefined, parentCtx);

      const callbacks = spawnSubagentMock.mock.calls[0]?.[3];
      expect(callbacks).toBeUndefined();
    });
  });

  describe('per-fork progress events (UI fan-out visibility)', () => {
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

    type ProgressCall = {
      toolName: string;
      message: string;
      metadata?: Record<string, unknown>;
    };

    function makeProgressCtx(deps: Record<string, unknown>): {
      ctx: ToolContext;
      progress: ProgressCall[];
    } {
      const progress: ProgressCall[] = [];
      const ctx = {
        abortSignal: new AbortController().signal,
        get<V>(key: string): V {
          if (key in deps) return deps[key] as V;
          throw new Error(`missing key ${key}`);
        },
        emitProgress: (
          toolName: string,
          message: string,
          metadata?: Record<string, unknown>,
        ) => {
          progress.push({ toolName, message, ...(metadata ? { metadata } : {}) });
        },
      } as ToolContext;
      return { ctx, progress };
    }

    it('emits start + end progress events with the skill name as toolName', async () => {
      makeForkSkill('judging-thread-quality');
      spawnSubagentMock.mockResolvedValueOnce({
        result: { keep: true },
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      const { ctx, progress } = makeProgressCtx({
        userId: 'u',
        productId: 'p',
      });

      await runForkSkill('judging-thread-quality', 'args', undefined, ctx);

      expect(progress.length).toBe(2);
      expect(progress[0]).toMatchObject({
        toolName: 'judging-thread-quality',
        message: 'fork started',
        metadata: { skillName: 'judging-thread-quality' },
      });
      expect(progress[1]!.toolName).toBe('judging-thread-quality');
      expect(progress[1]!.message).toMatch(/^fork done in \d+ms$/);
      expect(progress[1]!.metadata).toMatchObject({
        skillName: 'judging-thread-quality',
      });
      expect(progress[1]!.metadata!.elapsedMs).toEqual(expect.any(Number));
    });

    it('emits a `fork failed` progress event when spawnSubagent throws', async () => {
      makeForkSkill('judging-thread-quality');
      const boom = new Error('spawn boom');
      spawnSubagentMock.mockRejectedValueOnce(boom);

      const { ctx, progress } = makeProgressCtx({
        userId: 'u',
        productId: 'p',
      });

      await expect(
        runForkSkill('judging-thread-quality', 'args', undefined, ctx),
      ).rejects.toBe(boom);

      expect(progress.length).toBe(2);
      expect(progress[0]!.message).toBe('fork started');
      expect(progress[1]!.message).toMatch(/^fork failed in \d+ms$/);
      expect(progress[1]!.metadata).toMatchObject({
        skillName: 'judging-thread-quality',
        error: true,
      });
    });

    it('does not throw when ctx has no emitProgress (worker path with no progress sink)', async () => {
      makeForkSkill('lonely-skill');
      spawnSubagentMock.mockResolvedValueOnce({
        result: 'ok',
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      });

      // Plain deps record → createToolContext path. No emitProgress on the
      // resulting ctx. The optional-chained calls in runForkSkill must be
      // safe.
      await expect(
        runForkSkill('lonely-skill', 'args', undefined, {
          userId: 'u',
          productId: 'p',
        }),
      ).resolves.toBeDefined();
    });
  });
});
