// Shared registry of AgentDefinitions discoverable from disk under
// src/tools/AgentTool/agents/. Both the Task tool (to resolve subagent_type)
// and prompt.ts (to build the roster injected into the Task tool description)
// read through this module so they see the same list.
//
// Loading is lazy + cached for the process lifetime. A filesystem watcher
// on the agents root invalidates the cache when any `AGENT.md` (or
// reference `.md`) changes, so long-lived workers pick up description
// edits without a restart. The watcher is `persistent: false` so it
// never blocks a graceful shutdown; set `SHIPFLARE_DISABLE_AGENT_WATCHER=1`
// to opt out (tests + environments where `fs.watch` misbehaves).

import { resolve } from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import { loadAgentsDir, type AgentDefinition } from './loader';
import { createLogger } from '@/lib/logger';

const log = createLogger('tools:agent-registry');

const DEFAULT_AGENTS_ROOT = resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

/**
 * Debounce window for filesystem events. Editors typically fire
 * multiple events per save (write-then-rename or chmod). 200ms
 * collapses a burst into a single re-load.
 */
const WATCHER_DEBOUNCE_MS = 200;

interface RegistryState {
  root: string;
  /** Promise that resolves to the loaded agents, or `null` before first load. */
  promise: Promise<AgentDefinition[]> | null;
  /** Active fs.watch handle, or `null` when disabled / not yet started. */
  watcher: FSWatcher | null;
  /** Pending debounce timer for coalescing rapid FS events. */
  watcherDebounce: NodeJS.Timeout | null;
}

const state: RegistryState = {
  root: DEFAULT_AGENTS_ROOT,
  promise: null,
  watcher: null,
  watcherDebounce: null,
};

function isWatcherDisabled(): boolean {
  return (process.env.SHIPFLARE_DISABLE_AGENT_WATCHER ?? '').trim() === '1';
}

function tearDownWatcher(): void {
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch {
      // Closing an already-closed watcher throws on some Node versions;
      // nothing to do either way.
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
        // `filename` can be null on some platforms — treat as "something
        // changed" and invalidate to be safe. Filter to `.md` when we
        // have the filename so e.g. editor swap files don't thrash.
        if (filename && !filename.endsWith('.md')) return;
        if (state.watcherDebounce) clearTimeout(state.watcherDebounce);
        state.watcherDebounce = setTimeout(() => {
          state.watcherDebounce = null;
          log.info(
            `agent-registry: detected change (${filename ?? 'unknown'}) — invalidating cache`,
          );
          invalidateRegistry();
        }, WATCHER_DEBOUNCE_MS);
      },
    );
    watcher.on('error', (err) => {
      log.warn(
        `agent-registry: watcher error — disabling watcher. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      tearDownWatcher();
    });
    state.watcher = watcher;
    log.debug(`agent-registry: watching ${state.root} for AGENT.md changes`);
  } catch (err) {
    // Older kernels / constrained sandboxes may reject recursive
    // watching. Fall back to the stale-cache behaviour — callers who
    // really need freshness can call `__resetAgentRegistry()` manually.
    log.warn(
      `agent-registry: failed to start watcher (falling back to one-shot load): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Point the registry at a different agents directory (used by tests) and
 * invalidate the cache. Must be called before `getAvailableAgents()` on the
 * first access — otherwise the default root has already been loaded.
 */
export function __setAgentsRootForTesting(root: string): void {
  tearDownWatcher();
  state.root = root;
  state.promise = null;
}

/** Test hook: drop the cached load so a subsequent call re-reads disk. */
export function __resetAgentRegistry(): void {
  tearDownWatcher();
  state.promise = null;
}

/**
 * Load all AGENT.md files under the configured agents root. Caches the
 * resolved list in-process. `loadAgentsDir` already skips the `_shared`
 * directory (it has no AGENT.md), so no filter is needed here.
 */
export function getAvailableAgents(): Promise<AgentDefinition[]> {
  ensureWatcher();
  if (state.promise === null) {
    state.promise = loadAgentsDir(state.root).catch((err) => {
      // Reset so a subsequent retry re-attempts the load rather than
      // permanently caching the rejection.
      state.promise = null;
      throw err;
    });
  }
  return state.promise;
}

/**
 * Look up a single agent definition by `name` (the AGENT.md frontmatter
 * `name` field; matches `subagent_type` at the Task-tool boundary). Returns
 * `null` when no agent is registered under that name.
 */
export async function resolveAgent(
  subagentType: string,
): Promise<AgentDefinition | null> {
  const agents = await getAvailableAgents();
  return agents.find((a) => a.name === subagentType) ?? null;
}
