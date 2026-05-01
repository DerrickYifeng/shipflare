// Skill registry — programmatic registration for bundled skills + cached
// filesystem load. Mirrors src/tools/AgentTool/registry.ts pattern.
//
// Two sources merged:
// - Bundled skills (this module): registered via registerBundledSkill() at
//   import time, lives in process memory until process exit.
// - File skills (loadSkillsDir): scanned from disk, cached after first load,
//   invalidated by FS watcher on SKILL.md changes (Task 6).

import { createLogger } from '@/lib/logger';
import { loadSkillsDir } from './loadSkillsDir';
import type { SkillCommand } from './types';
import type { ToolContext } from '@/core/types';
import { SKILLS_ROOT } from './constants';

const log = createLogger('tools:skill-registry');

interface BundledSkillInput {
  name: string;
  description: string;
  whenToUse?: string;
  context?: 'inline' | 'fork';
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  argumentHint?: string;
  paths?: string[];
  getPromptForCommand: (args: string, ctx: ToolContext) => string | Promise<string>;
}

const bundledRegistry: SkillCommand[] = [];

interface RegistryState {
  root: string;
  promise: Promise<SkillCommand[]> | null;
}

const state: RegistryState = {
  root: SKILLS_ROOT,
  promise: null,
};

/**
 * Register a bundled (TS-defined) skill. Call from module side-effect imports
 * inside src/skills/_bundled/*.ts. Throws on duplicate name (within bundled
 * registry only — bundled-vs-file collisions resolve in getAllSkills with
 * bundled winning).
 */
export function registerBundledSkill(input: BundledSkillInput): void {
  const existing = bundledRegistry.find((s) => s.name === input.name);
  if (existing) {
    throw new Error(
      `Bundled skill "${input.name}" already registered (from ${existing.sourcePath ?? '<bundled>'})`,
    );
  }
  const skill: SkillCommand = {
    type: 'prompt',
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    context: input.context ?? 'inline',
    allowedTools: input.allowedTools ?? [],
    model: input.model,
    maxTurns: input.maxTurns,
    paths: input.paths,
    argumentHint: input.argumentHint,
    source: 'bundled',
    getPromptForCommand: input.getPromptForCommand,
  };
  bundledRegistry.push(skill);
  log.debug(`registered bundled skill "${input.name}"`);
}

/**
 * Return every loaded skill — bundled first, then file skills minus any
 * names that collide with bundled. Loaders are concurrent-safe; second
 * caller awaits the first caller's promise.
 */
export async function getAllSkills(): Promise<SkillCommand[]> {
  // Trigger bundled barrel side-effect import. Empty in Phase 1 but the
  // import itself ensures registerBundledSkill calls run before we read.
  await import('@/skills/_bundled');

  if (state.promise === null) {
    state.promise = loadSkillsDir(state.root).catch((err) => {
      state.promise = null;  // allow retry on next call
      throw err;
    });
  }
  const fileSkills = await state.promise;

  const bundledNames = new Set(bundledRegistry.map((s) => s.name));
  return [
    ...bundledRegistry,
    ...fileSkills.filter((s) => !bundledNames.has(s.name)),
  ];
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Reset both bundled registry and file cache. Vitest-only. */
export function __resetRegistryForTesting(): void {
  bundledRegistry.length = 0;
  state.promise = null;
}

/** Point the registry at a test fixtures dir. Must be called before getAllSkills. */
export function __setSkillsRootForTesting(root: string): void {
  state.root = root;
  state.promise = null;
}
