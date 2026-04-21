// Shared registry of AgentDefinitions discoverable from disk under
// src/tools/AgentTool/agents/. Both the Task tool (to resolve subagent_type)
// and prompt.ts (to build the roster injected into the Task tool description)
// read through this module so they see the same list.
//
// Loading is lazy + cached for the process lifetime. The agents root is
// configurable so tests can point at fixture directories.

import { resolve } from 'node:path';
import { loadAgentsDir, type AgentDefinition } from './loader';

const DEFAULT_AGENTS_ROOT = resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

interface RegistryState {
  root: string;
  /** Promise that resolves to the loaded agents, or `null` before first load. */
  promise: Promise<AgentDefinition[]> | null;
}

const state: RegistryState = {
  root: DEFAULT_AGENTS_ROOT,
  promise: null,
};

/**
 * Point the registry at a different agents directory (used by tests) and
 * invalidate the cache. Must be called before `getAvailableAgents()` on the
 * first access — otherwise the default root has already been loaded.
 */
export function __setAgentsRootForTesting(root: string): void {
  state.root = root;
  state.promise = null;
}

/** Test hook: drop the cached load so a subsequent call re-reads disk. */
export function __resetAgentRegistry(): void {
  state.promise = null;
}

/**
 * Load all AGENT.md files under the configured agents root. Caches the
 * resolved list in-process. `loadAgentsDir` already skips the `_shared`
 * directory (it has no AGENT.md), so no filter is needed here.
 */
export function getAvailableAgents(): Promise<AgentDefinition[]> {
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
