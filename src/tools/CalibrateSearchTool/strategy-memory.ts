// Standalone memory-key helpers + persisted-strategy type for the
// search-strategy MemoryStore entry. Lives apart from CalibrateSearchTool
// itself so consumers (RunDiscoveryScanTool, observability dashboards)
// can import the constants without pulling in `bridge/agent-runner` and
// triggering a circular dependency through the central tool registry.
//
// Loop that motivated the split:
//   registry.ts -> RunDiscoveryScanTool -> CalibrateSearchTool ->
//   bridge/agent-runner -> AgentTool/spawn -> registry.ts (mid-eval)
// Pulling the constants here breaks it: RunDiscoveryScanTool imports
// only this file, never CalibrateSearchTool.

import type { SearchStrategistOutput } from '@/tools/AgentTool/agents/search-strategist/schema';

/** Memory entry name template — read by run_discovery_scan to inject
 *  presetQueries into the v3-pipeline. Must stay stable across releases. */
export function searchStrategyMemoryName(platform: 'x' | 'reddit'): string {
  return `${platform}-search-strategy`;
}

/** Persisted strategy doc — JSON-stringified into the MemoryStore content
 *  column. Keep flat so a future migration can re-shape without touching
 *  the schema. */
export interface PersistedSearchStrategy extends SearchStrategistOutput {
  platform: 'x' | 'reddit';
  generatedAt: string; // ISO timestamp
  schemaVersion: 2;
}
