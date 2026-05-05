import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'node:path';
// Side-effect import: registry-team.ts wires the deferred-registration tools
// (Task, SendMessage, Skill) into the central registry. They're split out of
// registry.ts to avoid the module cycle through AgentTool/spawn.ts. Same
// convention as src/tools/__tests__/registry.test.ts.
import '@/tools/registry-team';
import { skillTool } from '@/tools/SkillTool/SkillTool';
import { registry } from '@/tools/registry';
import {
  registerBundledSkill,
  __resetRegistryForTesting,
  __setSkillsRootForTesting,
} from '@/tools/SkillTool/registry';

// Mock @/core/query-loop at the top so spawn.ts (transitively imported by
// SkillTool.ts) gets the mocked runAgent at module-init. The plan's
// `vi.doMock` + dynamic-re-import pattern doesn't work here because spawn.ts
// captures the runAgent binding at module load — a later doMock won't
// retroactively rewrite the closure. The deviation is documented in the
// task report.
const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock('@/core/query-loop', () => ({
  runAgent: runAgentMock,
}));

const SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', 'skills');

function fakeCtx() {
  return {
    abortSignal: new AbortController().signal,
    get: <V>(_key: string) => null as unknown as V,
  };
}

// Tracks whether the integration suite has already triggered the
// `@/skills/_bundled` side-effect import (which registers _bundled-smoke).
// Vitest caches that module after the first load, so on subsequent
// `beforeEach` resets we must re-register manually — but only after the
// first time, otherwise we'd race the side-effect's own
// `registerBundledSkill` call and double-register.
//
// NOTE: This latch assumes vitest runs tests in source order (the default).
// If `--shuffle` ever becomes default, replace this with an unconditional
// `getAllSkills()` once before any test, and drop the manual re-register.
let bundledSideEffectFired = false;

describe('SkillTool integration — end-to-end', () => {
  beforeEach(async () => {
    __resetRegistryForTesting();
    __setSkillsRootForTesting(SKILLS_DIR);
    runAgentMock.mockReset();

    if (!bundledSideEffectFired) {
      // First test in the file: trigger the bundled barrel side-effect
      // import. `getAllSkills()` does this internally — call it once so the
      // module gets loaded (and _bundled-smoke registered) under cached
      // semantics that match production.
      const { getAllSkills } = await import('@/tools/SkillTool/registry');
      await getAllSkills();
      bundledSideEffectFired = true;
    } else {
      // Subsequent tests: re-register manually because the cached
      // `@/skills/_bundled` module won't re-run its side-effect. This
      // keeps bundled-path coverage without `vi.resetModules()` (which
      // would invalidate the static `skillTool` import above).
      registerBundledSkill({
        name: '_bundled-smoke',
        description:
          'Phase 1 smoke skill — verifies bundled registration path. Internal.',
        context: 'inline',
        getPromptForCommand: () => 'BUNDLED SMOKE OK',
      });
    }
  });

  it('skillTool is in central registry', () => {
    expect(registry.get('skill')).toBeDefined();
  });

  it('inline mode: invokes _demo-echo-inline and returns ECHO_START block', async () => {
    const result = await skillTool.execute(
      { skill: '_demo-echo-inline', args: 'integration-test-arg' },
      fakeCtx() as never,
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('inline');
    expect(result.commandName).toBe('_demo-echo-inline');
    expect(result.content).toContain('ECHO_START');
    expect(result.content).toContain('args: integration-test-arg');
    expect(result.content).toContain('mode: inline');
    expect(result.content).toContain('ECHO_END');
  });

  it('inline mode: returns _bundled-smoke content via bundled path', async () => {
    const result = await skillTool.execute(
      { skill: '_bundled-smoke' },
      fakeCtx() as never,
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('inline');
    expect(result.content).toBe('BUNDLED SMOKE OK');
  });

  it('fork mode: dispatches to spawnSubagent (mocked) without throwing on dispatcher logic', async () => {
    runAgentMock.mockResolvedValue({
      result: 'ECHO_START\nargs: forked-test\nmode: forked\nECHO_END',
      cost: 0,
      duration: 0,
      turns: 0,
    });

    const result = await skillTool.execute(
      { skill: '_demo-echo-fork', args: 'forked-test' },
      fakeCtx() as never,
    );

    expect(result.status).toBe('forked');
    expect(result.content).toContain('mode: forked');
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('fork mode: wraps parent onEvent with spawnMeta so child events attribute to the fork specialist (regression — without the wrap fork-skill events attribute to the lead instead of the spawn, and SSE subscribers would also lose tool events entirely without forwarding)', async () => {
    runAgentMock.mockResolvedValue({
      result: 'OK',
      cost: 0,
      duration: 0,
      turns: 0,
    });

    const parentOnEvent = vi.fn();
    const fakeCtxWithOnEvent = {
      abortSignal: new AbortController().signal,
      get: <V>(key: string) => {
        if (key === 'onEvent') return parentOnEvent as unknown as V;
        return null as unknown as V;
      },
    };

    await skillTool.execute(
      { skill: '_demo-echo-fork', args: 'forwarded' },
      fakeCtxWithOnEvent as never,
    );

    // runAgent receives onEvent as its 8th positional arg (0-indexed 7) per spawn.ts.
    const lastCall = runAgentMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const wrappedOnEvent = lastCall?.[7] as
      | ((event: import('@/core/types').StreamEvent) => void | Promise<void>)
      | undefined;
    // Forwarding still lands a callable: SSE subscribers (e.g.
    // /api/onboarding/plan) require a function to receive child events.
    expect(typeof wrappedOnEvent).toBe('function');
    // After the wrap, the forwarded function is NOT the raw parent
    // callback — it's a closure that injects spawnMeta on the way
    // through. The deleted assertion `lastCall?.[7]).toBe(parentOnEvent)`
    // checked that *some* function was forwarded; the new assertions
    // below preserve that intent (it must reach the parent) AND verify
    // the new contract (it carries spawnMeta).
    expect(wrappedOnEvent).not.toBe(parentOnEvent);

    // Drive a tool_start through the wrapper. The parent must receive
    // the event with spawnMeta.fromMemberId / agentName attached, so
    // the worker's persist+publish layer can attribute the row to the
    // fork specialist instead of stamping the lead's memberId.
    await wrappedOnEvent!({
      type: 'tool_start',
      toolName: 'reddit_search',
      toolUseId: 'toolu_fork_child_1',
      input: { query: 'inside-fork' },
    });

    expect(parentOnEvent).toHaveBeenCalledTimes(1);
    const forwardedEvent = parentOnEvent.mock.calls[0]?.[0] as {
      spawnMeta?: import('@/core/types').StreamEventSpawnMeta;
    };
    expect(forwardedEvent.spawnMeta).toBeDefined();
    // agentName comes from the SKILL.md `name` so the UI can label the
    // delegation card "skill_<name>" without a registry round-trip.
    expect(forwardedEvent.spawnMeta!.agentName).toBe('skill__demo-echo-fork');
    // fakeCtx returns null for db/teamId so resolveSpecialistMemberId
    // can't look up a real row — the wrap must still fire (with a null
    // memberId fallback) so the parentToolUseId / agentName attribution
    // still reaches the worker.
    expect(forwardedEvent.spawnMeta!.fromMemberId).toBeNull();
  });

  it('fork mode: omits onEvent when parent ctx has none (non-team-scoped callers run quietly)', async () => {
    runAgentMock.mockResolvedValue({
      result: 'OK',
      cost: 0,
      duration: 0,
      turns: 0,
    });

    await skillTool.execute(
      { skill: '_demo-echo-fork', args: 'no-events' },
      fakeCtx() as never,
    );

    const lastCall = runAgentMock.mock.calls.at(-1);
    expect(lastCall?.[7]).toBeUndefined();
  });

  it('throws on unknown skill', async () => {
    await expect(
      skillTool.execute(
        { skill: 'no-such-skill-anywhere' },
        fakeCtx() as never,
      ),
    ).rejects.toThrow(/Unknown skill/);
  });

  // Phase 2 TODO: real agent-spawn-with-skill integration test that runs an
  // agent declaring `skills: [...]` through spawnSubagent and asserts the
  // preloaded body lands in the sub-agent's first turn. Requires either a
  // mocked LLM transcript or a full runAgent harness — out of Phase 1 scope.
  // Schema validation of the skills field is covered in loader.test.ts.
});
