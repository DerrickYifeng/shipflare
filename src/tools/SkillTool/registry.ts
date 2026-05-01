// Skill registry — programmatic registration for bundled skills + cached
// filesystem load with FS watcher invalidation. Mirrors
// src/tools/AgentTool/registry.ts pattern.

import { createLogger } from '@/lib/logger';
import { watch, type FSWatcher } from 'node:fs';
import { loadSkillsDir } from './loadSkillsDir';
import type { SkillCommand } from './types';
import type { ToolContext } from '@/core/types';
import { SKILLS_ROOT } from './constants';

const log = createLogger('tools:skill-registry');

const WATCHER_DEBOUNCE_MS = 200;

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
  watcher: FSWatcher | null;
  watcherDebounce: NodeJS.Timeout | null;
}

const state: RegistryState = {
  root: SKILLS_ROOT,
  promise: null,
  watcher: null,
  watcherDebounce: null,
};

function isWatcherDisabled(): boolean {
  return (process.env.SHIPFLARE_DISABLE_SKILL_WATCHER ?? '').trim() === '1';
}

function tearDownWatcher(): void {
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch {
      // Closing an already-closed watcher throws on some Node versions.
    }
    state.watcher = null;
  }
  if (state.watcherDebounce) {
    clearTimeout(state.watcherDebounce);
    state.watcherDebounce = null;
  }
}

function invalidateRegistry(): void {
  state.promise = null;
}

function ensureWatcher(): void {
  if (state.watcher) return;
  if (isWatcherDisabled()) return;

  try {
    const watcher = watch(
      state.root,
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        if (filename && !filename.endsWith('.md')) return;
        if (state.watcherDebounce) clearTimeout(state.watcherDebounce);
        state.watcherDebounce = setTimeout(() => {
          state.watcherDebounce = null;
          log.info(
            `skill-registry: detected change (${filename ?? 'unknown'}) — invalidating cache`,
          );
          invalidateRegistry();
        }, WATCHER_DEBOUNCE_MS);
      },
    );
    watcher.on('error', (err) => {
      log.warn(
        `skill-registry: watcher error — disabling. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      tearDownWatcher();
    });
    state.watcher = watcher;
    log.debug(`skill-registry: watching ${state.root} for SKILL.md changes`);
  } catch (err) {
    log.warn(
      `skill-registry: failed to start watcher: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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

export async function getAllSkills(): Promise<SkillCommand[]> {
  await import('@/skills/_bundled');
  ensureWatcher();
  if (state.promise === null) {
    state.promise = loadSkillsDir(state.root).catch((err) => {
      state.promise = null;
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

export function __resetRegistryForTesting(): void {
  tearDownWatcher();
  bundledRegistry.length = 0;
  state.promise = null;
}

export function __setSkillsRootForTesting(root: string): void {
  tearDownWatcher();
  state.root = root;
  state.promise = null;
}
